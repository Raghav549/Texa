import { prisma } from '../../config/db';
import { redis, cache } from '../../config/redis';
import { trackRoomGift } from './analytics';

export type GiftAnimationType =
  | 'confetti'
  | 'firework'
  | 'crown'
  | 'starburst'
  | 'rose_rain'
  | 'diamond_burst'
  | 'golden_shower'
  | 'royal_entry'
  | 'galaxy'
  | 'thunder';

export type GiftRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface GiftDefinition {
  id: string;
  name: string;
  price: number;
  animationType: GiftAnimationType;
  soundEffect?: string;
  icon?: string;
  rarity: GiftRarity;
  xpReward: number;
  comboWeight: number;
}

export interface GiftComboState {
  comboCount: number;
  comboLevel: 'single' | 'combo' | 'super_combo' | 'mega_combo' | 'royal_combo';
  multiplier: number;
  expiresAt: number;
}

export interface GiftResult {
  success: true;
  gift: GiftDefinition;
  giftRecordId: string;
  amount: number;
  receiverAmount: number;
  platformFee: number;
  newBalance: number;
  receiverBalance: number;
  animationType: GiftAnimationType;
  combo: GiftComboState;
  senderRank?: number;
  receiverRank?: number;
}

export interface GiftLeaderboardRow {
  rank: number;
  user: {
    id: string;
    username: string | null;
    avatarUrl: string | null;
    isVerified: boolean;
    level?: string | null;
  };
  score: number;
}

const BALANCE_KEY = 'user:balance';
const GIFT_COMBO_TTL_SECONDS = Number(process.env.GIFT_COMBO_TTL_SECONDS || 12);
const CREATOR_RANK_CACHE_TTL = Number(process.env.CREATOR_RANK_CACHE_TTL || 60);
const RECEIVER_SHARE = Number(process.env.GIFT_RECEIVER_SHARE || 0.7);
const PLATFORM_SHARE = Number(process.env.GIFT_PLATFORM_SHARE || 0.3);
const MAX_GIFT_AMOUNT = Number(process.env.MAX_GIFT_AMOUNT || 1_000_000);
const USER_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;
const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;
const GIFT_ID_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

export const GIFT_CATALOG: Record<string, GiftDefinition> = {
  rose: {
    id: 'rose',
    name: 'Rose',
    price: 10,
    animationType: 'rose_rain',
    soundEffect: 'soft_pop',
    icon: '🌹',
    rarity: 'common',
    xpReward: 2,
    comboWeight: 1
  },
  star: {
    id: 'star',
    name: 'Star',
    price: 50,
    animationType: 'starburst',
    soundEffect: 'sparkle',
    icon: '⭐',
    rarity: 'rare',
    xpReward: 8,
    comboWeight: 2
  },
  crown: {
    id: 'crown',
    name: 'Crown',
    price: 100,
    animationType: 'crown',
    soundEffect: 'royal_chime',
    icon: '👑',
    rarity: 'epic',
    xpReward: 15,
    comboWeight: 3
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    price: 250,
    animationType: 'firework',
    soundEffect: 'launch',
    icon: '🚀',
    rarity: 'epic',
    xpReward: 30,
    comboWeight: 5
  },
  diamond: {
    id: 'diamond',
    name: 'Diamond',
    price: 500,
    animationType: 'diamond_burst',
    soundEffect: 'crystal',
    icon: '💎',
    rarity: 'legendary',
    xpReward: 60,
    comboWeight: 8
  },
  thunder: {
    id: 'thunder',
    name: 'Thunder',
    price: 1000,
    animationType: 'thunder',
    soundEffect: 'thunder_hit',
    icon: '⚡',
    rarity: 'legendary',
    xpReward: 120,
    comboWeight: 12
  },
  galaxy: {
    id: 'galaxy',
    name: 'Galaxy',
    price: 2500,
    animationType: 'galaxy',
    soundEffect: 'space_boom',
    icon: '🌌',
    rarity: 'mythic',
    xpReward: 300,
    comboWeight: 25
  },
  maharaja: {
    id: 'maharaja',
    name: 'Maharaja Entry',
    price: 5000,
    animationType: 'royal_entry',
    soundEffect: 'royal_entry',
    icon: '🛕',
    rarity: 'mythic',
    xpReward: 700,
    comboWeight: 50
  }
};

function assertUserId(userId: string, label = 'userId') {
  if (!userId || typeof userId !== 'string' || !USER_ID_REGEX.test(userId)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertRoomId(roomId: string) {
  if (!roomId || typeof roomId !== 'string' || !ROOM_ID_REGEX.test(roomId)) {
    throw new Error('Invalid roomId');
  }
}

function assertGiftId(giftId: string) {
  if (!giftId || typeof giftId !== 'string' || !GIFT_ID_REGEX.test(giftId)) {
    throw new Error('Invalid giftId');
  }
}

function balanceCacheKey() {
  return BALANCE_KEY;
}

function comboKey(roomId: string, fromId: string, toId: string) {
  return `gift:combo:${roomId}:${fromId}:${toId}`;
}

function roomGiftStatsKey(roomId: string) {
  return `gift:room:${roomId}:stats`;
}

function userGiftSentKey(userId: string) {
  return `gift:user:${userId}:sent`;
}

function userGiftReceivedKey(userId: string) {
  return `gift:user:${userId}:received`;
}

function creatorRankKey() {
  return 'creator:ranking:gifts';
}

function normalizeAmount(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(Math.max(0, Math.min(value, MAX_GIFT_AMOUNT)));
}

function safeLimit(value: number, min = 1, max = 100) {
  const num = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(num) ? Math.floor(num) : min));
}

function getGift(giftId: string) {
  assertGiftId(giftId);
  const gift = GIFT_CATALOG[giftId];
  if (!gift) throw new Error('Invalid gift');
  return gift;
}

function getComboLevel(comboCount: number): GiftComboState['comboLevel'] {
  if (comboCount >= 50) return 'royal_combo';
  if (comboCount >= 25) return 'mega_combo';
  if (comboCount >= 10) return 'super_combo';
  if (comboCount >= 3) return 'combo';
  return 'single';
}

function getComboMultiplier(comboCount: number) {
  if (comboCount >= 50) return 2;
  if (comboCount >= 25) return 1.75;
  if (comboCount >= 10) return 1.5;
  if (comboCount >= 3) return 1.2;
  return 1;
}

function getReceiverShare(combo: GiftComboState) {
  const base = Number.isFinite(RECEIVER_SHARE) ? RECEIVER_SHARE : 0.7;
  const platform = Number.isFinite(PLATFORM_SHARE) ? PLATFORM_SHARE : 0.3;
  const normalizedBase = base > 0 && base < 1 ? base : 1 - platform;
  return Math.max(0.1, Math.min(0.9, normalizedBase + (combo.multiplier - 1) * 0.05));
}

function modelExists(txOrPrisma: any, model: string) {
  return Boolean(txOrPrisma?.[model]);
}

async function updateCombo(roomId: string, fromId: string, toId: string, weight: number): Promise<GiftComboState> {
  const key = comboKey(roomId, fromId, toId);
  const comboCount = await redis.incrby(key, Math.max(1, Math.floor(weight || 1)));
  await redis.expire(key, GIFT_COMBO_TTL_SECONDS);

  return {
    comboCount,
    comboLevel: getComboLevel(comboCount),
    multiplier: getComboMultiplier(comboCount),
    expiresAt: Date.now() + GIFT_COMBO_TTL_SECONDS * 1000
  };
}

async function getCachedBalance(userId: string) {
  assertUserId(userId);
  const cached = await redis.hget(balanceCacheKey(), userId);
  if (cached !== null && cached !== undefined) {
    const value = Number(cached);
    if (Number.isFinite(value)) return value;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  const coins = Number(user?.coins || 0);
  await redis.hset(balanceCacheKey(), userId, String(coins));
  return coins;
}

async function setCachedBalance(userId: string, coins: number) {
  assertUserId(userId);
  await redis.hset(balanceCacheKey(), userId, String(Math.max(0, Math.floor(Number(coins) || 0))));
}

async function clearUserEconomyCache(userId: string) {
  await Promise.all([
    cache.delete(`creator:economy:${userId}`).catch(() => null),
    cache.delete(`user:${userId}`).catch(() => null),
    cache.delete(`profile:${userId}`).catch(() => null)
  ]);
}

async function invalidateLeaderboardCaches() {
  await Promise.all([
    cache.delete('creator:gift_leaderboard:50').catch(() => null),
    cache.delete('creator:gift_leaderboard:100').catch(() => null)
  ]);
}

async function createCoinTransaction(tx: any, input: {
  userId: string;
  amount: number;
  balance: number;
  type: string;
  source?: string;
  status?: string;
  metadata?: Record<string, any>;
}) {
  if (!modelExists(tx, 'coinTransaction')) return null;

  return tx.coinTransaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      balance: input.balance,
      type: input.type,
      source: input.source || 'GIFT',
      status: input.status || 'COMPLETED',
      metadata: input.metadata || {}
    } as any
  }).catch(() => null);
}

async function ensureReceiverInRoom(roomId: string, toId: string) {
  const roomUserExists = await redis.sismember(`room:${roomId}:users`, toId);
  if (roomUserExists) return true;

  if (modelExists(prisma as any, 'seat')) {
    const seat = await (prisma as any).seat.findFirst({
      where: { roomId, userId: toId },
      select: { id: true }
    });
    if (seat) return true;
  }

  if (modelExists(prisma as any, 'voiceRoom')) {
    const room = await (prisma as any).voiceRoom.findFirst({
      where: {
        id: roomId,
        OR: [
          { hostId: toId },
          { speakers: { has: toId } },
          { listeners: { has: toId } }
        ]
      },
      select: { id: true }
    }).catch(() => null);
    if (room) return true;
  }

  return false;
}

async function createGiftRecord(tx: any, input: {
  fromId: string;
  toId: string;
  roomId: string;
  giftId: string;
  amount: number;
  receiverAmount: number;
  platformFee: number;
  gift: GiftDefinition;
  combo: GiftComboState;
}) {
  if (!modelExists(tx, 'gift')) {
    return {
      id: `${input.roomId}_${input.fromId}_${input.toId}_${input.giftId}_${Date.now()}`
    };
  }

  return tx.gift.create({
    data: {
      fromId: input.fromId,
      toId: input.toId,
      roomId: input.roomId,
      type: input.giftId,
      amount: input.amount,
      receiverAmount: input.receiverAmount,
      platformFee: input.platformFee,
      animationType: input.gift.animationType,
      comboCount: input.combo.comboCount,
      comboLevel: input.combo.comboLevel,
      metadata: {
        giftName: input.gift.name,
        rarity: input.gift.rarity,
        icon: input.gift.icon || null,
        soundEffect: input.gift.soundEffect || null,
        multiplier: input.combo.multiplier
      }
    } as any
  });
}

async function upsertCreatorEconomy(tx: any, userId: string, data: {
  totalEarnings?: number;
  giftsReceived?: number;
  giftCoinsReceived?: number;
  giftsSent?: number;
  giftCoinsSent?: number;
}) {
  if (!modelExists(tx, 'creatorEconomy')) return null;

  return tx.creatorEconomy.upsert({
    where: { userId },
    update: {
      ...(data.totalEarnings ? { totalEarnings: { increment: data.totalEarnings } } : {}),
      ...(data.giftsReceived ? { giftsReceived: { increment: data.giftsReceived } } : {}),
      ...(data.giftCoinsReceived ? { giftCoinsReceived: { increment: data.giftCoinsReceived } } : {}),
      ...(data.giftsSent ? { giftsSent: { increment: data.giftsSent } } : {}),
      ...(data.giftCoinsSent ? { giftCoinsSent: { increment: data.giftCoinsSent } } : {})
    },
    create: {
      userId,
      totalEarnings: data.totalEarnings || 0,
      giftsReceived: data.giftsReceived || 0,
      giftCoinsReceived: data.giftCoinsReceived || 0,
      giftsSent: data.giftsSent || 0,
      giftCoinsSent: data.giftCoinsSent || 0
    } as any
  }).catch(() => null);
}

export async function validateCoinBalance(userId: string, amount: number): Promise<boolean> {
  assertUserId(userId);
  const safeAmount = normalizeAmount(amount);
  if (safeAmount <= 0) return false;
  const balance = await getCachedBalance(userId);
  return balance >= safeAmount;
}

export async function getCoinBalance(userId: string) {
  return getCachedBalance(userId);
}

export async function refreshCoinBalance(userId: string) {
  assertUserId(userId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  const coins = Number(user?.coins || 0);
  await setCachedBalance(userId, coins);
  return coins;
}

export async function getGiftCatalog() {
  return Object.values(GIFT_CATALOG).sort((a, b) => a.price - b.price);
}

export async function getGiftById(giftId: string) {
  return getGift(giftId);
}

export async function processGift(fromId: string, toId: string, roomId: string, giftId: string, amount?: number): Promise<GiftResult> {
  assertUserId(fromId, 'fromId');
  assertUserId(toId, 'toId');
  assertRoomId(roomId);
  assertGiftId(giftId);

  if (fromId === toId) throw new Error('You cannot send gift to yourself');

  const gift = getGift(giftId);
  const finalAmount = normalizeAmount(amount || gift.price);

  if (finalAmount < gift.price) throw new Error('Gift amount is lower than gift price');
  if (finalAmount <= 0) throw new Error('Invalid gift amount');

  const receiverInRoom = await ensureReceiverInRoom(roomId, toId);
  if (!receiverInRoom) throw new Error('Receiver is not in this room');

  const combo = await updateCombo(roomId, fromId, toId, gift.comboWeight);
  const boostedReceiverShare = getReceiverShare(combo);
  const receiverAmount = Math.floor(finalAmount * boostedReceiverShare);
  const platformFee = finalAmount - receiverAmount;

  const result = await prisma.$transaction(async (tx) => {
    const sender = await tx.user.findUnique({
      where: { id: fromId },
      select: { id: true, coins: true, xp: true }
    });

    if (!sender) throw new Error('Sender not found');
    if (Number(sender.coins || 0) < finalAmount) throw new Error('Insufficient coins');

    const receiver = await tx.user.findUnique({
      where: { id: toId },
      select: { id: true, coins: true, xp: true }
    });

    if (!receiver) throw new Error('Receiver not found');

    const updatedSender = await tx.user.update({
      where: { id: fromId },
      data: {
        coins: { decrement: finalAmount },
        xp: { increment: gift.xpReward }
      },
      select: { coins: true }
    });

    const updatedReceiver = await tx.user.update({
      where: { id: toId },
      data: {
        coins: { increment: receiverAmount },
        xp: { increment: Math.max(1, Math.floor(gift.xpReward / 2)) }
      },
      select: { coins: true }
    });

    const giftRecord = await createGiftRecord(tx, {
      fromId,
      toId,
      roomId,
      giftId,
      amount: finalAmount,
      receiverAmount,
      platformFee,
      gift,
      combo
    });

    await upsertCreatorEconomy(tx, toId, {
      totalEarnings: receiverAmount,
      giftsReceived: 1,
      giftCoinsReceived: receiverAmount
    });

    await upsertCreatorEconomy(tx, fromId, {
      giftsSent: 1,
      giftCoinsSent: finalAmount
    });

    await createCoinTransaction(tx, {
      userId: fromId,
      amount: -finalAmount,
      balance: updatedSender.coins,
      type: 'GIFT_SENT',
      source: 'GIFT',
      metadata: {
        giftId,
        giftRecordId: giftRecord.id,
        roomId,
        toId,
        receiverAmount,
        platformFee
      }
    });

    await createCoinTransaction(tx, {
      userId: toId,
      amount: receiverAmount,
      balance: updatedReceiver.coins,
      type: 'GIFT_RECEIVED',
      source: 'GIFT',
      metadata: {
        giftId,
        giftRecordId: giftRecord.id,
        roomId,
        fromId,
        originalAmount: finalAmount,
        platformFee
      }
    });

    return {
      giftRecordId: giftRecord.id,
      newBalance: updatedSender.coins,
      receiverBalance: updatedReceiver.coins
    };
  });

  await Promise.all([
    setCachedBalance(fromId, result.newBalance),
    setCachedBalance(toId, result.receiverBalance),
    redis.hincrby(roomGiftStatsKey(roomId), 'totalAmount', finalAmount),
    redis.hincrby(roomGiftStatsKey(roomId), 'receiverAmount', receiverAmount),
    redis.hincrby(roomGiftStatsKey(roomId), 'platformFee', platformFee),
    redis.hincrby(roomGiftStatsKey(roomId), 'giftCount', 1),
    redis.hincrby(roomGiftStatsKey(roomId), `gift:${giftId}`, 1),
    redis.zincrby(userGiftSentKey(fromId), finalAmount, toId),
    redis.zincrby(userGiftReceivedKey(toId), finalAmount, fromId),
    redis.zincrby(creatorRankKey(), receiverAmount, toId),
    redis.expire(roomGiftStatsKey(roomId), 86400),
    redis.expire(userGiftSentKey(fromId), 86400 * 30),
    redis.expire(userGiftReceivedKey(toId), 86400 * 30),
    clearUserEconomyCache(toId),
    clearUserEconomyCache(fromId),
    invalidateLeaderboardCaches(),
    trackRoomGift(roomId, fromId, {
      toId,
      giftId,
      giftName: gift.name,
      amount: finalAmount,
      receiverAmount,
      platformFee,
      comboCount: combo.comboCount,
      comboLevel: combo.comboLevel,
      animationType: gift.animationType
    }).catch(() => null)
  ]);

  const [receiverRankRaw, senderRankRaw] = await Promise.all([
    redis.zrevrank(creatorRankKey(), toId),
    redis.zrevrank(creatorRankKey(), fromId)
  ]);

  return {
    success: true,
    gift,
    giftRecordId: result.giftRecordId,
    amount: finalAmount,
    receiverAmount,
    platformFee,
    newBalance: result.newBalance,
    receiverBalance: result.receiverBalance,
    animationType: gift.animationType,
    combo,
    receiverRank: typeof receiverRankRaw === 'number' ? receiverRankRaw + 1 : undefined,
    senderRank: typeof senderRankRaw === 'number' ? senderRankRaw + 1 : undefined
  };
}

export async function getRoomGiftStats(roomId: string) {
  assertRoomId(roomId);

  const stats = await redis.hgetall(roomGiftStatsKey(roomId));

  return {
    roomId,
    totalAmount: Number(stats.totalAmount || 0),
    receiverAmount: Number(stats.receiverAmount || 0),
    platformFee: Number(stats.platformFee || 0),
    giftCount: Number(stats.giftCount || 0),
    gifts: Object.fromEntries(
      Object.entries(stats)
        .filter(([key]) => key.startsWith('gift:'))
        .map(([key, value]) => [key.replace('gift:', ''), Number(value)])
    )
  };
}

export async function getTopGifters(userId: string, limit = 10) {
  assertUserId(userId);

  const safe = safeLimit(limit, 1, 100);
  const rows = await redis.zrevrange(userGiftReceivedKey(userId), 0, safe - 1, 'WITHSCORES');
  const result: Array<{ userId: string; amount: number }> = [];

  for (let i = 0; i < rows.length; i += 2) {
    result.push({ userId: rows[i], amount: Number(rows[i + 1] || 0) });
  }

  return result;
}

export async function getTopReceivers(userId: string, limit = 10) {
  assertUserId(userId);

  const safe = safeLimit(limit, 1, 100);
  const rows = await redis.zrevrange(userGiftSentKey(userId), 0, safe - 1, 'WITHSCORES');
  const result: Array<{ userId: string; amount: number }> = [];

  for (let i = 0; i < rows.length; i += 2) {
    result.push({ userId: rows[i], amount: Number(rows[i + 1] || 0) });
  }

  return result;
}

export async function getCreatorGiftRank(userId: string) {
  assertUserId(userId);

  const rank = await redis.zrevrank(creatorRankKey(), userId);
  const score = await redis.zscore(creatorRankKey(), userId);

  return {
    userId,
    rank: typeof rank === 'number' ? rank + 1 : null,
    score: Number(score || 0)
  };
}

export async function getCreatorGiftLeaderboard(limit = 50): Promise<GiftLeaderboardRow[]> {
  const safe = safeLimit(limit, 1, 100);
  const cacheKey = `creator:gift_leaderboard:${safe}`;
  const cached = await cache.get<GiftLeaderboardRow[]>(cacheKey);
  if (cached) return cached;

  const rows = await redis.zrevrange(creatorRankKey(), 0, safe - 1, 'WITHSCORES');
  const ids: string[] = [];
  const scores = new Map<string, number>();

  for (let i = 0; i < rows.length; i += 2) {
    ids.push(rows[i]);
    scores.set(rows[i], Number(rows[i + 1] || 0));
  }

  if (!ids.length) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      username: true,
      avatarUrl: true,
      isVerified: true,
      level: true
    } as any
  });

  const userMap = new Map(users.map((user: any) => [user.id, user]));

  const leaderboard = ids.map((id, index) => ({
    rank: index + 1,
    user: userMap.get(id) || { id, username: null, avatarUrl: null, isVerified: false, level: null },
    score: scores.get(id) || 0
  }));

  await cache.set(cacheKey, leaderboard, CREATOR_RANK_CACHE_TTL);
  return leaderboard;
}

export async function rebuildCreatorGiftRanking(limit = 1000) {
  const safe = safeLimit(limit, 1, 10000);

  if (!modelExists(prisma as any, 'creatorEconomy')) {
    return 0;
  }

  const creators = await (prisma as any).creatorEconomy.findMany({
    orderBy: { giftCoinsReceived: 'desc' },
    take: safe,
    select: {
      userId: true,
      giftCoinsReceived: true,
      totalEarnings: true
    }
  });

  const pipeline = redis.pipeline();
  pipeline.del(creatorRankKey());

  for (const creator of creators) {
    pipeline.zadd(creatorRankKey(), Number(creator.giftCoinsReceived || creator.totalEarnings || 0), creator.userId);
  }

  await pipeline.exec();
  await invalidateLeaderboardCaches();

  return creators.length;
}

export async function refundGift(giftRecordId: string, adminId?: string) {
  if (!giftRecordId || typeof giftRecordId !== 'string') throw new Error('Invalid giftRecordId');

  if (!modelExists(prisma as any, 'gift')) {
    throw new Error('Gift model not available');
  }

  const giftRecord = await (prisma as any).gift.findUnique({
    where: { id: giftRecordId }
  });

  if (!giftRecord) throw new Error('Gift not found');
  if ((giftRecord as any).refundedAt) throw new Error('Gift already refunded');

  const amount = normalizeAmount(Number(giftRecord.amount || 0));
  const receiverAmount = normalizeAmount(Number((giftRecord as any).receiverAmount || Math.floor(amount * RECEIVER_SHARE)));
  const platformFee = normalizeAmount(Number((giftRecord as any).platformFee || amount - receiverAmount));

  if (amount <= 0) throw new Error('Invalid refund amount');

  const result = await prisma.$transaction(async (tx) => {
    const receiver = await tx.user.findUnique({
      where: { id: giftRecord.toId },
      select: { coins: true }
    });

    if (!receiver) throw new Error('Receiver not found');
    if (Number(receiver.coins || 0) < receiverAmount) throw new Error('Receiver balance is lower than refund amount');

    const sender = await tx.user.update({
      where: { id: giftRecord.fromId },
      data: { coins: { increment: amount } },
      select: { coins: true }
    });

    const updatedReceiver = await tx.user.update({
      where: { id: giftRecord.toId },
      data: { coins: { decrement: receiverAmount } },
      select: { coins: true }
    });

    await (tx as any).gift.update({
      where: { id: giftRecordId },
      data: {
        refundedAt: new Date(),
        refundedBy: adminId || null
      } as any
    });

    if (modelExists(tx as any, 'creatorEconomy')) {
      await (tx as any).creatorEconomy.updateMany({
        where: { userId: giftRecord.toId },
        data: {
          totalEarnings: { decrement: receiverAmount },
          giftCoinsReceived: { decrement: receiverAmount }
        }
      });

      await (tx as any).creatorEconomy.updateMany({
        where: { userId: giftRecord.fromId },
        data: {
          giftCoinsSent: { decrement: amount }
        }
      });
    }

    await createCoinTransaction(tx, {
      userId: giftRecord.fromId,
      amount,
      balance: sender.coins,
      type: 'GIFT_REFUND_RECEIVED',
      source: 'ADMIN',
      metadata: {
        giftRecordId,
        adminId: adminId || null,
        toId: giftRecord.toId,
        receiverAmount,
        platformFee
      }
    });

    await createCoinTransaction(tx, {
      userId: giftRecord.toId,
      amount: -receiverAmount,
      balance: updatedReceiver.coins,
      type: 'GIFT_REFUND_DEBIT',
      source: 'ADMIN',
      metadata: {
        giftRecordId,
        adminId: adminId || null,
        fromId: giftRecord.fromId,
        originalAmount: amount,
        platformFee
      }
    });

    return {
      senderBalance: sender.coins,
      receiverBalance: updatedReceiver.coins
    };
  });

  await Promise.all([
    setCachedBalance(giftRecord.fromId, result.senderBalance),
    setCachedBalance(giftRecord.toId, result.receiverBalance),
    redis.zincrby(creatorRankKey(), -receiverAmount, giftRecord.toId),
    clearUserEconomyCache(giftRecord.toId),
    clearUserEconomyCache(giftRecord.fromId),
    invalidateLeaderboardCaches()
  ]);

  return {
    success: true,
    refundedAmount: amount,
    receiverDeducted: receiverAmount,
    platformFee,
    senderBalance: result.senderBalance,
    receiverBalance: result.receiverBalance
  };
}

export async function clearGiftRoomStats(roomId: string) {
  assertRoomId(roomId);
  await redis.del(roomGiftStatsKey(roomId));
  return { roomId, cleared: true };
}

export async function clearGiftCombo(roomId: string, fromId: string, toId: string) {
  assertRoomId(roomId);
  assertUserId(fromId, 'fromId');
  assertUserId(toId, 'toId');
  await redis.del(comboKey(roomId, fromId, toId));
  return { roomId, fromId, toId, cleared: true };
}

export async function syncUserCoinCache(userIds: string[]) {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, coins: true }
  });

  if (!users.length) return 0;

  const pipeline = redis.pipeline();
  for (const user of users) {
    pipeline.hset(balanceCacheKey(), user.id, String(Number(user.coins || 0)));
  }
  await pipeline.exec();

  return users.length;
}
