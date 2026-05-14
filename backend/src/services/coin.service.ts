import { prisma } from '../config/db';
import { redis, cache } from '../config/redis';
import { TransactionStatus, TransactionType, WalletSource } from '@prisma/client';

export type CoinSource =
  | WalletSource
  | 'ADMIN'
  | 'SYSTEM'
  | 'GIFT'
  | 'TASK'
  | 'REWARD'
  | 'REFERRAL'
  | 'PURCHASE'
  | 'WITHDRAWAL'
  | 'AD'
  | 'BONUS'
  | 'REFUND'
  | 'TRANSFER';

export type CoinUpdateOptions = {
  type?: TransactionType | string;
  source?: CoinSource;
  status?: TransactionStatus | string;
  referenceId?: string | null;
  reason?: string | null;
  metadata?: Record<string, any>;
  allowNegative?: boolean;
  actorId?: string | null;
};

export type CoinTransferOptions = CoinUpdateOptions & {
  fee?: number;
};

const BALANCE_KEY = 'user:balance';
const COIN_LEADERBOARD_KEY = 'coins:leaderboard';
const COIN_CACHE_TTL = 300;

function balanceCacheKey() {
  return BALANCE_KEY;
}

function userCoinHistoryCacheKey(userId: string, limit: number) {
  return `coin:history:${userId}:${limit}`;
}

function safeAmount(value: number) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error('Invalid coin amount');
  return Math.trunc(amount);
}

function normalizePositiveAmount(value: number) {
  const amount = safeAmount(value);
  if (amount <= 0) throw new Error('Coin amount must be greater than zero');
  return amount;
}

function normalizeDelta(value: number) {
  const amount = safeAmount(value);
  if (amount === 0) throw new Error('Coin delta cannot be zero');
  return amount;
}

function normalizeSource(source?: CoinSource) {
  const raw = String(source || WalletSource.ADMIN).trim().toUpperCase();
  const values = Object.values(WalletSource) as string[];
  return (values.includes(raw) ? raw : WalletSource.ADMIN) as WalletSource;
}

function normalizeType(type: any, delta: number) {
  const raw = String(type || '').trim().toUpperCase();
  const values = Object.values(TransactionType) as string[];
  if (values.includes(raw)) return raw as TransactionType;
  if (delta >= 0) {
    if (values.includes('CREDIT')) return 'CREDIT' as TransactionType;
    if (values.includes('EARN')) return 'EARN' as TransactionType;
    if (values.includes('REWARD')) return 'REWARD' as TransactionType;
  }
  if (values.includes('DEBIT')) return 'DEBIT' as TransactionType;
  if (values.includes('SPEND')) return 'SPEND' as TransactionType;
  if (values.includes('WITHDRAW')) return 'WITHDRAW' as TransactionType;
  return values[0] as TransactionType;
}

function normalizeStatus(status?: any) {
  const raw = String(status || 'COMPLETED').trim().toUpperCase();
  const values = Object.values(TransactionStatus) as string[];
  if (values.includes(raw)) return raw as TransactionStatus;
  if (values.includes('SUCCESS')) return 'SUCCESS' as TransactionStatus;
  if (values.includes('COMPLETED')) return 'COMPLETED' as TransactionStatus;
  return values[0] as TransactionStatus;
}

function buildTransactionData(userId: string, delta: number, balance: number, options: CoinUpdateOptions = {}) {
  return {
    userId,
    amount: Math.abs(delta),
    delta,
    balance,
    type: normalizeType(options.type, delta),
    source: normalizeSource(options.source),
    status: normalizeStatus(options.status),
    referenceId: options.referenceId || null,
    reason: options.reason || null,
    actorId: options.actorId || null,
    metadata: options.metadata || {}
  } as any;
}

async function setCachedBalance(userId: string, coins: number) {
  await Promise.all([
    redis.hset(balanceCacheKey(), userId, String(coins)),
    redis.zadd(COIN_LEADERBOARD_KEY, coins, userId),
    redis.expire(balanceCacheKey(), COIN_CACHE_TTL)
  ]).catch(() => null);
}

async function invalidateCoinCaches(userId: string) {
  await Promise.all([
    cache.delete(`creator:economy:${userId}`).catch(() => null),
    cache.delete(userCoinHistoryCacheKey(userId, 20)).catch(() => null),
    cache.delete(userCoinHistoryCacheKey(userId, 50)).catch(() => null),
    cache.delete(userCoinHistoryCacheKey(userId, 100)).catch(() => null)
  ]);
}

export async function getCoinBalance(userId: string) {
  if (!userId) throw new Error('userId is required');

  const cached = await redis.hget(balanceCacheKey(), userId).catch(() => null);
  if (cached !== null && cached !== undefined) return Number(cached);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  const coins = user?.coins || 0;
  await setCachedBalance(userId, coins);
  return coins;
}

export async function refreshCoinBalance(userId: string) {
  if (!userId) throw new Error('userId is required');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  if (!user) throw new Error('User not found');

  await setCachedBalance(userId, user.coins || 0);
  return user.coins || 0;
}

export async function updateCoins(userId: string, delta: number, options: CoinUpdateOptions = {}) {
  if (!userId) throw new Error('userId is required');

  const safeDelta = normalizeDelta(delta);

  const result = await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, coins: true }
    });

    if (!user) throw new Error('User not found');

    const currentBalance = user.coins || 0;
    const nextBalance = currentBalance + safeDelta;

    if (!options.allowNegative && nextBalance < 0) throw new Error('Insufficient coins');

    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        coins: {
          increment: safeDelta
        }
      },
      select: {
        id: true,
        coins: true,
        xp: true,
        username: true,
        avatarUrl: true,
        isVerified: true,
        level: true
      }
    });

    const transaction = await (tx as any).coinTransaction.create({
      data: buildTransactionData(userId, safeDelta, updated.coins || 0, options)
    }).catch(() => null);

    return {
      user: updated,
      transaction,
      previousBalance: currentBalance,
      balance: updated.coins || 0,
      delta: safeDelta
    };
  });

  await setCachedBalance(userId, result.balance);
  await invalidateCoinCaches(userId);

  return result.user;
}

export async function creditCoins(userId: string, amount: number, options: CoinUpdateOptions = {}) {
  const safe = normalizePositiveAmount(amount);
  return updateCoins(userId, safe, {
    ...options,
    type: options.type || 'CREDIT',
    source: options.source || WalletSource.ADMIN
  });
}

export async function debitCoins(userId: string, amount: number, options: CoinUpdateOptions = {}) {
  const safe = normalizePositiveAmount(amount);
  return updateCoins(userId, -safe, {
    ...options,
    type: options.type || 'DEBIT',
    source: options.source || WalletSource.ADMIN
  });
}

export async function addCoins(userId: string, amount: number, options: CoinUpdateOptions = {}) {
  return creditCoins(userId, amount, options);
}

export async function removeCoins(userId: string, amount: number, options: CoinUpdateOptions = {}) {
  return debitCoins(userId, amount, options);
}

export async function canSpendCoins(userId: string, amount: number) {
  const safe = normalizePositiveAmount(amount);
  const balance = await getCoinBalance(userId);
  return balance >= safe;
}

export async function transferCoins(fromId: string, toId: string, amount: number, options: CoinTransferOptions = {}) {
  if (!fromId || !toId) throw new Error('fromId and toId are required');
  if (fromId === toId) throw new Error('Cannot transfer coins to yourself');

  const safe = normalizePositiveAmount(amount);
  const fee = Math.max(0, safeAmount(options.fee || 0));
  const totalDebit = safe + fee;

  const result = await prisma.$transaction(async tx => {
    const sender = await tx.user.findUnique({
      where: { id: fromId },
      select: { id: true, coins: true }
    });

    if (!sender) throw new Error('Sender not found');
    if ((sender.coins || 0) < totalDebit && !options.allowNegative) throw new Error('Insufficient coins');

    const receiver = await tx.user.findUnique({
      where: { id: toId },
      select: { id: true, coins: true }
    });

    if (!receiver) throw new Error('Receiver not found');

    const updatedSender = await tx.user.update({
      where: { id: fromId },
      data: { coins: { decrement: totalDebit } },
      select: { id: true, coins: true, username: true, avatarUrl: true, isVerified: true, level: true }
    });

    const updatedReceiver = await tx.user.update({
      where: { id: toId },
      data: { coins: { increment: safe } },
      select: { id: true, coins: true, username: true, avatarUrl: true, isVerified: true, level: true }
    });

    const referenceId = options.referenceId || `transfer:${fromId}:${toId}:${Date.now()}`;

    await (tx as any).coinTransaction.create({
      data: buildTransactionData(fromId, -totalDebit, updatedSender.coins || 0, {
        ...options,
        type: options.type || 'DEBIT',
        source: options.source || WalletSource.ADMIN,
        referenceId,
        metadata: {
          ...(options.metadata || {}),
          toId,
          amount: safe,
          fee
        }
      })
    }).catch(() => null);

    await (tx as any).coinTransaction.create({
      data: buildTransactionData(toId, safe, updatedReceiver.coins || 0, {
        ...options,
        type: options.type || 'CREDIT',
        source: options.source || WalletSource.ADMIN,
        referenceId,
        metadata: {
          ...(options.metadata || {}),
          fromId,
          amount: safe,
          fee
        }
      })
    }).catch(() => null);

    return {
      sender: updatedSender,
      receiver: updatedReceiver,
      amount: safe,
      fee,
      referenceId
    };
  });

  await Promise.all([
    setCachedBalance(fromId, result.sender.coins || 0),
    setCachedBalance(toId, result.receiver.coins || 0),
    invalidateCoinCaches(fromId),
    invalidateCoinCaches(toId)
  ]);

  return result;
}

export async function rewardCoins(userId: string, amount: number, reason?: string, metadata: Record<string, any> = {}) {
  return creditCoins(userId, amount, {
    type: 'CREDIT',
    source: 'REWARD',
    reason: reason || 'Reward',
    metadata
  });
}

export async function refundCoins(userId: string, amount: number, referenceId?: string, metadata: Record<string, any> = {}) {
  return creditCoins(userId, amount, {
    type: 'CREDIT',
    source: 'REFUND',
    referenceId: referenceId || null,
    reason: 'Refund',
    metadata
  });
}

export async function spendCoins(userId: string, amount: number, reason?: string, metadata: Record<string, any> = {}) {
  return debitCoins(userId, amount, {
    type: 'DEBIT',
    source: 'PURCHASE',
    reason: reason || 'Spend',
    metadata
  });
}

export async function bulkRewardCoins(userIds: string[], amount: number, options: CoinUpdateOptions = {}) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  const safe = normalizePositiveAmount(amount);
  const results = [];

  for (const userId of ids) {
    try {
      results.push({
        userId,
        success: true,
        user: await creditCoins(userId, safe, {
          ...options,
          type: options.type || 'CREDIT',
          source: options.source || 'REWARD'
        })
      });
    } catch (error: any) {
      results.push({
        userId,
        success: false,
        error: error?.message || 'Reward failed'
      });
    }
  }

  return results;
}

export async function getCoinTransactions(userId: string, limit = 50) {
  if (!userId) throw new Error('userId is required');

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const cacheKey = userCoinHistoryCacheKey(userId, safeLimit);
  const cached = await cache.get<any[]>(cacheKey).catch(() => null);
  if (cached) return cached;

  const rows = await (prisma as any).coinTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: safeLimit
  }).catch(() => []);

  await cache.set(cacheKey, rows, 30).catch(() => null);
  return rows;
}

export async function getCoinLeaderboard(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);

  const cached = await cache.get<any[]>(`coin:leaderboard:${safeLimit}`).catch(() => null);
  if (cached) return cached;

  const rows = await prisma.user.findMany({
    where: {
      coins: {
        gt: 0
      }
    },
    select: {
      id: true,
      username: true,
      avatarUrl: true,
      isVerified: true,
      level: true,
      coins: true
    },
    orderBy: {
      coins: 'desc'
    },
    take: safeLimit
  });

  const leaderboard = rows.map((user, index) => ({
    rank: index + 1,
    user,
    coins: user.coins || 0
  }));

  await cache.set(`coin:leaderboard:${safeLimit}`, leaderboard, 60).catch(() => null);

  const pipeline = redis.pipeline();
  for (const row of rows) pipeline.zadd(COIN_LEADERBOARD_KEY, row.coins || 0, row.id);
  pipeline.expire(COIN_LEADERBOARD_KEY, 3600);
  await pipeline.exec().catch(() => null);

  return leaderboard;
}

export async function rebuildCoinLeaderboard(limit = 1000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 10000);

  const users = await prisma.user.findMany({
    where: {
      coins: {
        gt: 0
      }
    },
    select: {
      id: true,
      coins: true
    },
    orderBy: {
      coins: 'desc'
    },
    take: safeLimit
  });

  const pipeline = redis.pipeline();
  pipeline.del(COIN_LEADERBOARD_KEY);

  for (const user of users) {
    pipeline.zadd(COIN_LEADERBOARD_KEY, user.coins || 0, user.id);
    pipeline.hset(balanceCacheKey(), user.id, String(user.coins || 0));
  }

  pipeline.expire(COIN_LEADERBOARD_KEY, 3600);
  pipeline.expire(balanceCacheKey(), COIN_CACHE_TTL);
  await pipeline.exec().catch(() => null);
  await cache.delete(`coin:leaderboard:50`).catch(() => null);

  return users.length;
}

export async function syncCoinBalance(userId: string) {
  return refreshCoinBalance(userId);
}

export async function resetCoins(userId: string, amount = 0, options: CoinUpdateOptions = {}) {
  if (!userId) throw new Error('userId is required');

  const safe = Math.max(0, safeAmount(amount));

  const result = await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { coins: true }
    });

    if (!user) throw new Error('User not found');

    const delta = safe - (user.coins || 0);

    const updated = await tx.user.update({
      where: { id: userId },
      data: { coins: safe },
      select: {
        id: true,
        coins: true,
        username: true,
        avatarUrl: true,
        isVerified: true,
        level: true
      }
    });

    await (tx as any).coinTransaction.create({
      data: buildTransactionData(userId, delta, updated.coins || 0, {
        ...options,
        type: delta >= 0 ? 'CREDIT' : 'DEBIT',
        source: options.source || WalletSource.ADMIN,
        reason: options.reason || 'Balance reset'
      })
    }).catch(() => null);

    return updated;
  });

  await setCachedBalance(userId, result.coins || 0);
  await invalidateCoinCaches(userId);

  return result;
}
