import cron, { ScheduledTask } from 'node-cron';

import { prisma } from '../config/db';
import { redis, cache } from '../config/redis';
import { io } from '../app';
import { flushAllBufferedRoomAnalytics } from './voice/roomAnalytics.service';
import { rebuildCreatorGiftRanking } from './voice/gift.service';
import { refreshAdQualityScore } from './ad.service';
import { calculateTrendingScore } from './feed.service';

type SchedulerJob = {
  name: string;
  expression: string;
  timezone?: string;
  runOnStart?: boolean;
  task: () => Promise<any>;
};

type SchedulerStatus = {
  initialized: boolean;
  startedAt: Date | null;
  jobs: string[];
  running: Record<string, boolean>;
  lastRun: Record<string, string>;
  lastError: Record<string, string>;
};

const DEFAULT_TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'Asia/Kolkata';
const SCHEDULER_LOCK_PREFIX = 'scheduler:lock';
const SCHEDULER_LOCK_TTL_SECONDS = 240;
const runningJobs = new Map<string, boolean>();
const tasks = new Map<string, ScheduledTask>();
const lastRun = new Map<string, string>();
const lastError = new Map<string, string>();
let initialized = false;
let startedAt: Date | null = null;

function schedulerLockKey(name: string) {
  return `${SCHEDULER_LOCK_PREFIX}:${name}`;
}

function normalizeLimit(value: any, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function acquireJobLock(name: string, ttl = SCHEDULER_LOCK_TTL_SECONDS) {
  const key = schedulerLockKey(name);
  const lock = await redis.set(key, String(Date.now()), 'EX', ttl, 'NX').catch(() => null);
  return !!lock;
}

async function releaseJobLock(name: string) {
  await redis.del(schedulerLockKey(name)).catch(() => undefined);
}

async function safeEmit(roomOrUser: string | null, event: string, payload?: any) {
  try {
    if (roomOrUser) io.to(roomOrUser).emit(event, payload);
    else io.emit(event, payload);
  } catch {}
}

async function runJob(name: string, task: () => Promise<any>) {
  if (runningJobs.get(name)) return { skipped: true, reason: 'local_running' };

  const locked = await acquireJobLock(name);
  if (!locked) return { skipped: true, reason: 'distributed_locked' };

  runningJobs.set(name, true);

  try {
    const result = await task();
    lastRun.set(name, new Date().toISOString());
    lastError.delete(name);
    return result;
  } catch (error: any) {
    lastError.set(name, error?.message || 'unknown_error');
    console.error(`${name} scheduler error:`, error);
    return { failed: true, reason: error?.message || 'unknown_error' };
  } finally {
    runningJobs.set(name, false);
    await releaseJobLock(name);
  }
}

async function autoVerifyUsers() {
  const candidates = await prisma.user.findMany({
    where: {
      isVerified: false,
      NOT: {
        username: 'kashyap'
      }
    },
    select: {
      id: true,
      username: true,
      followers: true,
      xp: true,
      level: true,
      createdAt: true
    } as any,
    take: 500
  });

  let verified = 0;

  for (const user of candidates as any[]) {
    const followerCount = Array.isArray(user.followers) ? user.followers.length : 0;
    const xp = Number(user.xp || 0);
    const level = Number(user.level || 0);

    if (followerCount >= 1000 || xp >= 50000 || level >= 50) {
      await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true }
      });

      await prisma.notification.create({
        data: {
          userId: user.id,
          title: 'Verification unlocked',
          body: 'Your TEXA profile is now verified.',
          type: 'system',
          data: {
            reason: followerCount >= 1000 ? 'followers' : xp >= 50000 ? 'xp' : 'level'
          }
        } as any
      }).catch(() => null);

      await safeEmit(user.id, 'verify:success', { userId: user.id });
      verified++;
    }
  }

  return { verified };
}

async function cleanupExpiredStories() {
  const expiredStories = await prisma.story.findMany({
    where: {
      expiresAt: {
        lt: new Date()
      }
    },
    select: {
      id: true,
      userId: true
    },
    take: 1000
  }).catch(() => []);

  if (!expiredStories.length) return { deleted: 0 };

  const deleted = await prisma.story.deleteMany({
    where: {
      id: {
        in: expiredStories.map(story => story.id)
      }
    }
  });

  const userIds = Array.from(new Set(expiredStories.map(story => story.userId).filter(Boolean)));

  await Promise.all(userIds.map(userId => cache.delete(`user:${userId}:stories`).catch(() => undefined)));
  await cache.delete('stories:feed').catch(() => undefined);

  return { deleted: deleted.count };
}

async function resolveDailyTrading() {
  const trade = await prisma.tradeDay.findFirst({
    where: {
      isActive: true
    }
  }).catch(() => null);

  if (!trade) return { resolved: false, reason: 'no_active_trade' };

  const choices = Array.isArray((trade as any).choices) ? (trade as any).choices : [];
  if (!choices.length) return { resolved: false, reason: 'no_choices' };

  const winner = choices.reduce((a: any, b: any) => {
    const aScore = Number(a.votes || 0) + Number(a.invested || 0);
    const bScore = Number(b.votes || 0) + Number(b.invested || 0);
    return aScore >= bScore ? a : b;
  });

  if (!winner?.id) return { resolved: false, reason: 'invalid_winner' };

  const winners = await prisma.tradeVote.findMany({
    where: {
      tradeId: trade.id,
      choiceId: winner.id,
      isInvested: true
    }
  }).catch(() => []);

  const transaction: any[] = [];

  for (const vote of winners as any[]) {
    const amount = Math.max(0, Math.floor(Number(vote.amount || 0)));
    if (amount > 0) {
      transaction.push(
        prisma.user.update({
          where: { id: vote.userId },
          data: {
            coins: {
              increment: amount
            }
          }
        })
      );
      transaction.push(
        prisma.coinTransaction.create({
          data: {
            userId: vote.userId,
            amount,
            balance: 0,
            type: 'CREDIT',
            status: 'SUCCESS',
            source: 'ADMIN',
            metadata: {
              tradeId: trade.id,
              choiceId: winner.id,
              reason: 'daily_trade_win'
            }
          } as any
        }).catch(() => null)
      );
    }
  }

  transaction.push(
    prisma.tradeVote.deleteMany({
      where: {
        tradeId: trade.id
      }
    })
  );

  transaction.push(
    prisma.tradeDay.update({
      where: {
        id: trade.id
      },
      data: {
        isActive: false,
        closedAt: new Date(),
        winnerChoiceId: winner.id
      } as any
    })
  );

  await prisma.$transaction(transaction.filter(Boolean) as any);

  await safeEmit(null, 'trading:reset', {
    tradeId: trade.id,
    winner
  });

  return {
    resolved: true,
    tradeId: trade.id,
    winner,
    winners: winners.length
  };
}

async function flushRoomAnalyticsBuffers() {
  const result = await flushAllBufferedRoomAnalytics().catch(error => {
    throw error;
  });

  return {
    flushed: Array.isArray(result) ? result.filter((item: any) => item.flushed).length : 0,
    total: Array.isArray(result) ? result.length : 0,
    result
  };
}

async function rebuildGiftRankings() {
  const limit = normalizeLimit(process.env.CREATOR_GIFT_RANK_REBUILD_LIMIT, 1000, 50, 10000);
  const count = await rebuildCreatorGiftRanking(limit);
  await cache.delete('creator:gift_leaderboard:50').catch(() => undefined);
  return { rebuilt: count };
}

async function refreshActiveAdQualityScores() {
  const ads = await prisma.advertisement.findMany({
    where: {
      status: 'active'
    } as any,
    select: {
      id: true
    },
    orderBy: {
      updatedAt: 'asc'
    } as any,
    take: 200
  }).catch(() => []);

  let updated = 0;

  for (const ad of ads as any[]) {
    const result = await refreshAdQualityScore(ad.id).catch(() => null);
    if (result) updated++;
  }

  return { updated };
}

async function refreshTrendingReels() {
  const reels = await prisma.reel.findMany({
    where: {
      visibility: 'public',
      moderationStatus: 'approved',
      isDraft: false,
      publishedAt: {
        lte: new Date(),
        gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      }
    } as any,
    include: {
      author: {
        select: {
          id: true,
          followers: true,
          isVerified: true,
          createdAt: true
        }
      },
      _count: {
        select: {
          likes: true,
          comments: true,
          shares: true,
          saves: true
        } as any
      }
    },
    orderBy: {
      updatedAt: 'asc'
    } as any,
    take: 300
  }).catch(() => []);

  let updated = 0;

  for (const reel of reels as any[]) {
    const trendingScore = calculateTrendingScore(reel);
    await prisma.reel.update({
      where: { id: reel.id },
      data: {
        trendingScore
      } as any
    }).then(() => {
      updated++;
    }).catch(() => undefined);
  }

  return { updated };
}

async function cleanupInactiveVoiceRooms() {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const rooms = await prisma.voiceRoom.findMany({
    where: {
      isActive: true,
      updatedAt: {
        lt: cutoff
      }
    },
    select: {
      id: true,
      hostId: true
    },
    take: 200
  }).catch(() => []);

  let closed = 0;

  for (const room of rooms as any[]) {
    const onlineCount = await redis.scard(`room:${room.id}:users`).catch(() => 0);
    const seatCount = await prisma.seat.count({ where: { roomId: room.id } }).catch(() => 0);

    if (onlineCount === 0 && seatCount === 0) {
      await prisma.voiceRoom.update({
        where: { id: room.id },
        data: {
          isActive: false,
          isLocked: true,
          endedAt: new Date()
        } as any
      }).catch(() => null);

      await redis.del(
        `room:${room.id}:users`,
        `room:${room.id}:seats`,
        `room:${room.id}:state`,
        `room:${room.id}:music`,
        `room:${room.id}:poll`,
        `room:${room.id}:chat_buffer`
      ).catch(() => undefined);

      await redis.srem('voice:rooms:active', room.id).catch(() => undefined);
      closed++;
    }
  }

  return { closed };
}

async function cleanupOldNotifications() {
  const days = normalizeLimit(process.env.NOTIFICATION_RETENTION_DAYS, 60, 7, 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await prisma.notification.deleteMany({
    where: {
      createdAt: {
        lt: cutoff
      },
      read: true
    } as any
  }).catch(() => ({ count: 0 }));

  return { deleted: result.count };
}

async function cleanupModerationLogs() {
  const model = (prisma as any).moderationLog;
  if (!model?.deleteMany) return { deleted: 0, skipped: true };

  const days = normalizeLimit(process.env.MODERATION_LOG_RETENTION_DAYS, 90, 15, 730);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await model.deleteMany({
    where: {
      createdAt: {
        lt: cutoff
      },
      reviewRequired: false
    }
  }).catch(() => ({ count: 0 }));

  return { deleted: result.count };
}

async function cleanupExpiredKicksAndPresence() {
  const stream = redis.scanStream({
    match: 'room:*:presence:*',
    count: 200
  });

  let checked = 0;
  let removed = 0;

  await new Promise<void>((resolve, reject) => {
    stream.on('data', async (keys: string[]) => {
      stream.pause();

      try {
        for (const key of keys) {
          checked++;
          const ttl = await redis.ttl(key).catch(() => -2);
          if (ttl === -1) {
            await redis.expire(key, 45).catch(() => undefined);
            removed++;
          }
        }
      } finally {
        stream.resume();
      }
    });

    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return { checked, fixed: removed };
}

async function createDailyTradeIfMissing() {
  const model = (prisma as any).tradeDay;
  if (!model?.findFirst || !model?.create) return { skipped: true };

  const active = await model.findFirst({
    where: {
      isActive: true
    }
  }).catch(() => null);

  if (active) return { created: false, reason: 'already_active' };

  const today = new Date();
  const title = `Daily Market ${today.toISOString().slice(0, 10)}`;

  const trade = await model.create({
    data: {
      title,
      isActive: true,
      choices: [
        {
          id: 'bull',
          label: 'Bull',
          votes: 0,
          invested: 0
        },
        {
          id: 'bear',
          label: 'Bear',
          votes: 0,
          invested: 0
        }
      ],
      openedAt: new Date()
    } as any
  }).catch(() => null);

  if (trade) {
    await safeEmit(null, 'trading:new_day', { tradeId: trade.id });
  }

  return { created: !!trade, tradeId: trade?.id };
}

function registerJob(job: SchedulerJob) {
  if (tasks.has(job.name)) return;

  const scheduled = cron.schedule(
    job.expression,
    () => {
      void runJob(job.name, job.task);
    },
    {
      timezone: job.timezone || DEFAULT_TIMEZONE,
      scheduled: true
    }
  );

  tasks.set(job.name, scheduled);

  if (job.runOnStart) {
    setTimeout(() => {
      void runJob(job.name, job.task);
    }, 1500);
  }
}

export function initSchedulers() {
  if (initialized) return getSchedulerStatus();

  initialized = true;
  startedAt = new Date();

  const jobs: SchedulerJob[] = [
    {
      name: 'auto_verify_users',
      expression: '*/5 * * * *',
      task: autoVerifyUsers
    },
    {
      name: 'cleanup_expired_stories',
      expression: '0 * * * *',
      task: cleanupExpiredStories
    },
    {
      name: 'resolve_daily_trading',
      expression: '55 23 * * *',
      task: resolveDailyTrading
    },
    {
      name: 'create_daily_trade_if_missing',
      expression: '5 0 * * *',
      task: createDailyTradeIfMissing
    },
    {
      name: 'flush_room_analytics_buffers',
      expression: '*/2 * * * *',
      runOnStart: true,
      task: flushRoomAnalyticsBuffers
    },
    {
      name: 'rebuild_creator_gift_rankings',
      expression: '*/15 * * * *',
      runOnStart: true,
      task: rebuildGiftRankings
    },
    {
      name: 'refresh_active_ad_quality_scores',
      expression: '*/20 * * * *',
      task: refreshActiveAdQualityScores
    },
    {
      name: 'refresh_trending_reels',
      expression: '*/10 * * * *',
      task: refreshTrendingReels
    },
    {
      name: 'cleanup_inactive_voice_rooms',
      expression: '*/30 * * * *',
      task: cleanupInactiveVoiceRooms
    },
    {
      name: 'cleanup_old_notifications',
      expression: '20 3 * * *',
      task: cleanupOldNotifications
    },
    {
      name: 'cleanup_moderation_logs',
      expression: '35 3 * * *',
      task: cleanupModerationLogs
    },
    {
      name: 'cleanup_expired_presence',
      expression: '*/15 * * * *',
      task: cleanupExpiredKicksAndPresence
    }
  ];

  for (const job of jobs) registerJob(job);

  return getSchedulerStatus();
}

export function stopSchedulers() {
  for (const task of tasks.values()) {
    task.stop();
  }

  tasks.clear();
  runningJobs.clear();
  initialized = false;

  return getSchedulerStatus();
}

export function getSchedulerStatus(): SchedulerStatus {
  return {
    initialized,
    startedAt,
    jobs: Array.from(tasks.keys()),
    running: Object.fromEntries(Array.from(runningJobs.entries())),
    lastRun: Object.fromEntries(Array.from(lastRun.entries())),
    lastError: Object.fromEntries(Array.from(lastError.entries()))
  };
}

export async function runSchedulerJobNow(name: string) {
  const jobs: Record<string, () => Promise<any>> = {
    auto_verify_users: autoVerifyUsers,
    cleanup_expired_stories: cleanupExpiredStories,
    resolve_daily_trading: resolveDailyTrading,
    create_daily_trade_if_missing: createDailyTradeIfMissing,
    flush_room_analytics_buffers: flushRoomAnalyticsBuffers,
    rebuild_creator_gift_rankings: rebuildGiftRankings,
    refresh_active_ad_quality_scores: refreshActiveAdQualityScores,
    refresh_trending_reels: refreshTrendingReels,
    cleanup_inactive_voice_rooms: cleanupInactiveVoiceRooms,
    cleanup_old_notifications: cleanupOldNotifications,
    cleanup_moderation_logs: cleanupModerationLogs,
    cleanup_expired_presence: cleanupExpiredKicksAndPresence
  };

  const task = jobs[name];
  if (!task) throw new Error('Unknown scheduler job');

  return runJob(name, task);
}
