import { prisma } from '../config/db';
import { io } from '../app';
import { redis, cache } from '../config/redis';
import { addXP } from './xp.service';
import { updateCoins } from './coin.service';
import { NotificationType, TransactionStatus, TransactionType, WalletSource } from '@prisma/client';

type DailyLoginRewardResult = {
  rewarded: boolean;
  userId: string;
  streak: number;
  coins: number;
  xp: number;
  milestoneBonus: number;
  totalCoins: number;
  totalXp: number;
  nextRewardAt: Date;
};

const DAILY_LOGIN_LOCK_TTL_MS = 15_000;
const DAILY_LOGIN_CACHE_TTL_SECONDS = 86_400;
const MAX_BASE_COINS = 100;
const BASE_COIN_STEP = 10;
const BASE_XP_STEP = 1;
const MAX_BASE_XP = 50;
const MILESTONE_BONUSES: Record<number, number> = {
  3: 20,
  7: 75,
  14: 150,
  30: 500,
  60: 1200,
  100: 3000,
  365: 15000
};

function getUtcDayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getNextUtcDayStart(date = new Date()) {
  const start = getUtcDayStart(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function isSameUtcDay(a?: Date | null, b = new Date()) {
  if (!a) return false;
  return getUtcDayStart(a).getTime() === getUtcDayStart(b).getTime();
}

function isYesterdayUtc(a?: Date | null, b = new Date()) {
  if (!a) return false;
  const yesterdayStart = new Date(getUtcDayStart(b).getTime() - 24 * 60 * 60 * 1000);
  return getUtcDayStart(a).getTime() === yesterdayStart.getTime();
}

function dailyLoginLockKey(userId: string) {
  return `daily_login:lock:${userId}`;
}

function dailyLoginRewardKey(userId: string, date = new Date()) {
  return `daily_login:reward:${userId}:${getUtcDayStart(date).toISOString().slice(0, 10)}`;
}

function normalizeUserId(userId: string) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('Invalid userId');
  return id;
}

function getBaseCoins(streak: number) {
  return Math.min(Math.max(streak, 1) * BASE_COIN_STEP, MAX_BASE_COINS);
}

function getBaseXp(streak: number) {
  return Math.min(Math.max(streak, 1) * BASE_XP_STEP, MAX_BASE_XP);
}

function getMilestoneBonus(streak: number) {
  return MILESTONE_BONUSES[streak] || 0;
}

async function emitDailyReward(userId: string, payload: DailyLoginRewardResult) {
  try {
    io.to(userId).emit('daily:reward', payload);
    io.to(`user:${userId}`).emit('daily:reward', payload);
  } catch {}
}

async function createDailyRewardNotification(userId: string, payload: DailyLoginRewardResult) {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: NotificationType.REWARD,
        title: 'Daily reward unlocked',
        message: `Day ${payload.streak} streak reward: ${payload.totalCoins} coins and ${payload.totalXp} XP`,
        metadata: {
          streak: payload.streak,
          coins: payload.coins,
          xp: payload.xp,
          milestoneBonus: payload.milestoneBonus,
          totalCoins: payload.totalCoins,
          totalXp: payload.totalXp,
          nextRewardAt: payload.nextRewardAt.toISOString()
        }
      } as any
    });
  } catch {}
}

async function createCoinTransaction(userId: string, amount: number, balance: number, streak: number) {
  if (amount <= 0) return null;

  try {
    return await prisma.coinTransaction.create({
      data: {
        userId,
        amount,
        balance,
        type: TransactionType.EARN,
        status: TransactionStatus.COMPLETED,
        source: WalletSource.REWARD,
        description: `Daily login streak reward - Day ${streak}`,
        metadata: {
          reason: 'daily_login',
          streak
        }
      } as any
    });
  } catch {
    return null;
  }
}

async function invalidateUserRewardCaches(userId: string) {
  await Promise.all([
    cache.delete(`user:${userId}`),
    cache.delete(`user:${userId}:profile`),
    cache.delete(`user:${userId}:safe`),
    cache.delete(`wallet:${userId}`),
    cache.delete(`creator:economy:${userId}`),
    redis.hdel('user:balance', userId).catch(() => 0)
  ]);
}

export async function handleDailyLogin(userId: string): Promise<DailyLoginRewardResult> {
  const id = normalizeUserId(userId);
  const now = new Date();
  const lockKey = dailyLoginLockKey(id);
  const rewardKey = dailyLoginRewardKey(id, now);
  const nextRewardAt = getNextUtcDayStart(now);

  const cachedReward = await cache.get<DailyLoginRewardResult>(rewardKey).catch(() => null);
  if (cachedReward) return cachedReward;

  const lock = await redis.set(lockKey, '1', 'PX', DAILY_LOGIN_LOCK_TTL_MS, 'NX');
  if (!lock) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, loginStreak: true, coins: true, xp: true, lastLogin: true }
    });

    return {
      rewarded: false,
      userId: id,
      streak: user?.loginStreak || 0,
      coins: 0,
      xp: 0,
      milestoneBonus: 0,
      totalCoins: user?.coins || 0,
      totalXp: user?.xp || 0,
      nextRewardAt
    };
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        coins: true,
        xp: true,
        lastLogin: true,
        loginStreak: true
      }
    });

    if (!user) throw new Error('User not found');

    if (isSameUtcDay(user.lastLogin, now)) {
      const result: DailyLoginRewardResult = {
        rewarded: false,
        userId: id,
        streak: user.loginStreak || 0,
        coins: 0,
        xp: 0,
        milestoneBonus: 0,
        totalCoins: user.coins || 0,
        totalXp: user.xp || 0,
        nextRewardAt
      };

      await cache.set(rewardKey, result, Math.max(60, Math.floor((nextRewardAt.getTime() - now.getTime()) / 1000)));
      return result;
    }

    const streak = isYesterdayUtc(user.lastLogin, now) ? (user.loginStreak || 0) + 1 : 1;
    const baseCoins = getBaseCoins(streak);
    const baseXp = getBaseXp(streak);
    const milestoneBonus = getMilestoneBonus(streak);
    const totalRewardCoins = baseCoins + milestoneBonus;
    const totalRewardXp = baseXp + Math.floor(milestoneBonus / 10);

    const updatedUser = await prisma.$transaction(async tx => {
      const latest = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          coins: true,
          xp: true,
          lastLogin: true,
          loginStreak: true
        }
      });

      if (!latest) throw new Error('User not found');

      if (isSameUtcDay(latest.lastLogin, now)) {
        return {
          alreadyRewarded: true,
          coins: latest.coins || 0,
          xp: latest.xp || 0,
          loginStreak: latest.loginStreak || 0
        };
      }

      const latestStreak = isYesterdayUtc(latest.lastLogin, now) ? (latest.loginStreak || 0) + 1 : 1;
      const latestBaseCoins = getBaseCoins(latestStreak);
      const latestBaseXp = getBaseXp(latestStreak);
      const latestMilestoneBonus = getMilestoneBonus(latestStreak);
      const latestTotalCoins = latestBaseCoins + latestMilestoneBonus;
      const latestTotalXp = latestBaseXp + Math.floor(latestMilestoneBonus / 10);

      const updated = await tx.user.update({
        where: { id },
        data: {
          lastLogin: now,
          loginStreak: latestStreak,
          coins: { increment: latestTotalCoins },
          xp: { increment: latestTotalXp }
        },
        select: {
          coins: true,
          xp: true,
          loginStreak: true
        }
      });

      await createCoinTransaction(id, latestTotalCoins, updated.coins, latestStreak);

      return {
        alreadyRewarded: false,
        coins: updated.coins,
        xp: updated.xp,
        loginStreak: updated.loginStreak,
        rewardCoins: latestTotalCoins,
        rewardXp: latestTotalXp,
        milestoneBonus: latestMilestoneBonus
      };
    });

    if ((updatedUser as any).alreadyRewarded) {
      const result: DailyLoginRewardResult = {
        rewarded: false,
        userId: id,
        streak: updatedUser.loginStreak || 0,
        coins: 0,
        xp: 0,
        milestoneBonus: 0,
        totalCoins: updatedUser.coins || 0,
        totalXp: updatedUser.xp || 0,
        nextRewardAt
      };

      await cache.set(rewardKey, result, Math.max(60, Math.floor((nextRewardAt.getTime() - now.getTime()) / 1000)));
      return result;
    }

    const result: DailyLoginRewardResult = {
      rewarded: true,
      userId: id,
      streak: updatedUser.loginStreak || streak,
      coins: (updatedUser as any).rewardCoins || totalRewardCoins,
      xp: (updatedUser as any).rewardXp || totalRewardXp,
      milestoneBonus: (updatedUser as any).milestoneBonus || milestoneBonus,
      totalCoins: updatedUser.coins || 0,
      totalXp: updatedUser.xp || 0,
      nextRewardAt
    };

    await Promise.all([
      invalidateUserRewardCaches(id),
      cache.set(rewardKey, result, Math.max(60, Math.floor((nextRewardAt.getTime() - now.getTime()) / 1000))),
      redis.set(`daily_login:last:${id}`, now.toISOString(), 'EX', DAILY_LOGIN_CACHE_TTL_SECONDS),
      emitDailyReward(id, result),
      createDailyRewardNotification(id, result)
    ]);

    return result;
  } finally {
    await redis.del(lockKey);
  }
}

export async function getDailyLoginStatus(userId: string) {
  const id = normalizeUserId(userId);
  const now = new Date();
  const nextRewardAt = getNextUtcDayStart(now);

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      coins: true,
      xp: true,
      lastLogin: true,
      loginStreak: true
    }
  });

  if (!user) throw new Error('User not found');

  const claimedToday = isSameUtcDay(user.lastLogin, now);
  const nextStreak = claimedToday ? user.loginStreak || 0 : isYesterdayUtc(user.lastLogin, now) ? (user.loginStreak || 0) + 1 : 1;
  const milestoneBonus = getMilestoneBonus(nextStreak);

  return {
    userId: id,
    claimedToday,
    streak: user.loginStreak || 0,
    nextStreak,
    nextCoins: claimedToday ? 0 : getBaseCoins(nextStreak) + milestoneBonus,
    nextXp: claimedToday ? 0 : getBaseXp(nextStreak) + Math.floor(milestoneBonus / 10),
    milestoneBonus: claimedToday ? 0 : milestoneBonus,
    nextRewardAt,
    totalCoins: user.coins || 0,
    totalXp: user.xp || 0
  };
}

export async function resetDailyLoginStreak(userId: string) {
  const id = normalizeUserId(userId);

  const user = await prisma.user.update({
    where: { id },
    data: {
      loginStreak: 0,
      lastLogin: null
    },
    select: {
      id: true,
      loginStreak: true,
      lastLogin: true
    }
  });

  await Promise.all([
    redis.del(dailyLoginLockKey(id)),
    redis.del(`daily_login:last:${id}`),
    cache.delete(`user:${id}`),
    cache.delete(`user:${id}:profile`)
  ]);

  return user;
}
