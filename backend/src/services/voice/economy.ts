import { prisma } from '../../config/db';
import { redis, cache } from '../../config/redis';

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

export interface GiftDefinition {
  id: string;
  name: string;
  price: number;
  animationType: GiftAnimationType;
  soundEffect?: string;
  icon?: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
  xpReward: number;
  comboWeight: number;
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

export interface GiftComboState {
  comboCount: number;
  comboLevel: 'single' | 'combo' | 'super_combo' | 'mega_combo' | 'royal_combo';
  multiplier: number;
  expiresAt: number;
}

const BALANCE_KEY = 'user:balance';
const GIFT_COMBO_TTL_SECONDS = 12;
const CREATOR_RANK_CACHE_TTL = 60;
const RECEIVER_SHARE = 0.7;
const PLATFORM_SHARE = 0.3;

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
  return Math.floor(Math.max(0, value));
}

function getGift(giftId: string) {
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

async function updateCombo(roomId: string, fromId: string, toId: string, weight: number): Promise<GiftComboState> {
  const key = comboKey(roomId, fromId, toId);
  const comboCount = await redis.incrby(key, weight);
  await redis.expire(key, GIFT_COMBO_TTL_SECONDS);

  return {
    comboCount,
    comboLevel: getComboLevel(comboCount),
    multiplier: getComboMultiplier(comboCount),
    expiresAt: Date.now() + GIFT_COMBO_TTL_SECONDS * 1000
  };
}

async function getCachedBalance(userId: string) {
  const cached = await redis.hget(balanceCacheKey(), userId);
  if (cached !== null) return Number(cached);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  const coins = user?.coins || 0;
  await redis.hset(balanceCacheKey(), userId, String(coins));
  return coins;
}

async function setCachedBalance(userId: string, coins: number) {
  await redis.hset(balanceCacheKey(), userId, String(coins));
}

async function incrementCachedBalance(userId: string, amount: number) {
  return redis.hincrby(balanceCacheKey(), userId, amount);
}

export async function validateCoinBalance(userId: string, amount: number): Promise<boolean> {
  const safeAmount = normalizeAmount(amount);
  if (safeAmount <= 0) return false;
  const balance = await getCachedBalance(userId);
  return balance >= safeAmount;
}

export async function getCoinBalance(userId: string) {
  return getCachedBalance(userId);
}

export async function refreshCoinBalance(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  const coins = user?.coins || 0;
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
  if (!fromId || !toId || !roomId || !giftId) throw new Error('Missing gift data');
  if (fromId === toId) throw new Error('You cannot send gift to yourself');

  const gift = getGift(giftId);
  const finalAmount = normalizeAmount(amount || gift.price);

  if (finalAmount < gift.price) throw new Error('Gift amount is lower than gift price');

  const roomUserExists = await redis.sismember(`room:${roomId}:users`, toId);
  if (!roomUserExists) {
    const seat = await prisma.seat.findFirst({
      where: { roomId, userId: toId },
      select: { id: true }
    });
    if (!seat) throw new Error('Receiver is not in this room');
  }

  const combo = await updateCombo(roomId, fromId, toId, gift.comboWeight);
  const boostedReceiverShare = Math.min(0.85, RECEIVER_SHARE + (combo.multiplier - 1) * 0.05);
  const receiverAmount = Math.floor(finalAmount * boostedReceiverShare);
  const platformFee = finalAmount - receiverAmount;

  const result = await prisma.$transaction(async tx => {
    const sender = await tx.user.findUnique({
      where: { id: fromId },
      select: { id: true, coins: true, xp: true }
    });

    if (!sender) throw new Error('Sender not found');
    if (sender.coins < finalAmount) throw new Error('Insufficient coins');

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

    const giftRecord = await tx.gift.create({
      data: {
        fromId,
        toId,
        roomId,
        type: giftId,
        amount: finalAmount,
        receiverAmount,
        platformFee,
        animationType: gift.animationType,
        comboCount: combo.comboCount,
        comboLevel: combo.comboLevel
      }
    });

    await tx.creatorEconomy.upsert({
      where: { userId: toId },
      update: {
        totalEarnings: { increment: receiverAmount },
        giftsReceived: { increment: 1 },
        giftCoinsReceived: { increment: receiverAmount }
      },
      create: {
        userId: toId,
        totalEarnings: receiverAmount,
        giftsReceived: 1,
        giftCoinsReceived: receiverAmount
      }
    });

    await tx.creatorEconomy.upsert({
      where: { userId: fromId },
      update: {
        giftsSent: { increment: 1 },
        giftCoinsSent: { increment: finalAmount }
      },
      create: {
        userId: fromId,
        totalEarnings: 0,
        giftsReceived: 0,
        giftsSent: 1,
        giftCoinsSent: finalAmount
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
    redis.hincrby(roomGiftStatsKey(roomId), 'giftCount', 1),
    redis.hincrby(roomGiftStatsKey(roomId), `gift:${giftId}`, 1),
    redis.zincrby(userGiftSentKey(fromId), finalAmount, toId),
    redis.zincrby(userGiftReceivedKey(toId), finalAmount, fromId),
    redis.zincrby(creatorRankKey(), receiverAmount, toId),
    redis.expire(roomGiftStatsKey(roomId), 86400),
    redis.expire(userGiftSentKey(fromId), 86400 * 30),
    redis.expire(userGiftReceivedKey(toId), 86400 * 30),
    cache.delete(`creator:economy:${toId}`),
    cache.delete(`creator:economy:${fromId}`)
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
  const stats = await redis.hgetall(roomGiftStatsKey(roomId));
  return {
    roomId,
    totalAmount: Number(stats.totalAmount || 0),
    giftCount: Number(stats.giftCount || 0),
    gifts: Object.fromEntries(
      Object.entries(stats)
        .filter(([key]) => key.startsWith('gift:'))
        .map(([key, value]) => [key.replace('gift:', ''), Number(value)])
    )
  };
}

export async function getTopGifters(userId: string, limit = 10) {
  const rows = await redis.zrevrange(userGiftReceivedKey(userId), 0, limit - 1, 'WITHSCORES');
  const result: Array<{ userId: string; amount: number }> = [];

  for (let i = 0; i < rows.length; i += 2) {
    result.push({ userId: rows[i], amount: Number(rows[i + 1]) });
  }

  return result;
}

export async function getTopReceivers(userId: string, limit = 10) {
  const rows = await redis.zrevrange(userGiftSentKey(userId), 0, limit - 1, 'WITHSCORES');
  const result: Array<{ userId: string; amount: number }> = [];

  for (let i = 0; i < rows.length; i += 2) {
    result.push({ userId: rows[i], amount: Number(rows[i + 1]) });
  }

  return result;
}

export async function getCreatorGiftRank(userId: string) {
  const rank = await redis.zrevrank(creatorRankKey(), userId);
  const score = await redis.zscore(creatorRankKey(), userId);

  return {
    userId,
    rank: typeof rank === 'number' ? rank + 1 : null,
    score: Number(score || 0)
  };
}

export async function getCreatorGiftLeaderboard(limit = 50) {
  const cached = await cache.get<any[]>(`creator:gift_leaderboard:${limit}`);
  if (cached) return cached;

  const rows = await redis.zrevrange(creatorRankKey(), 0, limit - 1, 'WITHSCORES');
  const ids: string[] = [];
  const scores = new Map<string, number>();

  for (let i = 0; i < rows.length; i += 2) {
    ids.push(rows[i]);
    scores.set(rows[i], Number(rows[i + 1]));
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
    }
  });

  const userMap = new Map(users.map(user => [user.id, user]));

  const leaderboard = ids.map((id, index) => ({
    rank: index + 1,
    user: userMap.get(id) || { id, username: null, avatarUrl: null, isVerified: false, level: null },
    score: scores.get(id) || 0
  }));

  await cache.set(`creator:gift_leaderboard:${limit}`, leaderboard, CREATOR_RANK_CACHE_TTL);
  return leaderboard;
}

export async function rebuildCreatorGiftRanking(limit = 1000) {
  const creators = await prisma.creatorEconomy.findMany({
    orderBy: { giftCoinsReceived: 'desc' },
    take: limit,
    select: {
      userId: true,
      giftCoinsReceived: true,
      totalEarnings: true
    }
  });

  const pipeline = redis.pipeline();
  pipeline.del(creatorRankKey());

  for (const creator of creators) {
    pipeline.zadd(creatorRankKey(), creator.giftCoinsReceived || creator.totalEarnings || 0, creator.userId);
  }

  await pipeline.exec();
  await cache.delete(`creator:gift_leaderboard:50`);

  return creators.length;
}

export async function refundGift(giftRecordId: string, adminId?: string) {
  const giftRecord = await prisma.gift.findUnique({
    where: { id: giftRecordId }
  });

  if (!giftRecord) throw new Error('Gift not found');
  if ((giftRecord as any).refundedAt) throw new Error('Gift already refunded');

  const amount = giftRecord.amount || 0;
  const receiverAmount = (giftRecord as any).receiverAmount || Math.floor(amount * RECEIVER_SHARE);

  const result = await prisma.$transaction(async tx => {
    const sender = await tx.user.update({
      where: { id: giftRecord.fromId },
      data: { coins: { increment: amount } },
      select: { coins: true }
    });

    const receiver = await tx.user.update({
      where: { id: giftRecord.toId },
      data: { coins: { decrement: receiverAmount } },
      select: { coins: true }
    });

    await tx.gift.update({
      where: { id: giftRecordId },
      data: {
        refundedAt: new Date(),
        refundedBy: adminId || null
      } as any
    });

    await tx.creatorEconomy.updateMany({
      where: { userId: giftRecord.toId },
      data: {
        totalEarnings: { decrement: receiverAmount },
        giftCoinsReceived: { decrement: receiverAmount }
      }
    });

    return {
      senderBalance: sender.coins,
      receiverBalance: receiver.coins
    };
  });

  await Promise.all([
    setCachedBalance(giftRecord.fromId, result.senderBalance),
    setCachedBalance(giftRecord.toId, result.receiverBalance),
    redis.zincrby(creatorRankKey(), -receiverAmount, giftRecord.toId),
    cache.delete(`creator:economy:${giftRecord.toId}`),
    cache.delete(`creator:economy:${giftRecord.fromId}`)
  ]);

  return {
    success: true,
    refundedAmount: amount,
    senderBalance: result.senderBalance,
    receiverBalance: result.receiverBalance
  };
}
