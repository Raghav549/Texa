import cron, { ScheduledTask } from 'node-cron';

import { prisma } from '../config/db';
import { redis } from '../config/redis';

export type TrustLevel = 'new' | 'rising' | 'trusted' | 'premium' | 'elite';

export type TrustBreakdown = {
  score: number;
  rating: number;
  level: TrustLevel;
  orderVolumeScore: number;
  revenueScore: number;
  ratingScore: number;
  reviewConfidenceScore: number;
  deliveryScore: number;
  cancellationScore: number;
  disputePenalty: number;
  refundPenalty: number;
  verificationBonus: number;
  ageBonus: number;
  activityBonus: number;
  responseBonus: number;
  repeatBuyerBonus: number;
  productHealthBonus: number;
  riskPenalty: number;
  meta: {
    orderCount: number;
    recentOrderCount: number;
    totalRevenue: number;
    recentRevenue: number;
    deliveredCount: number;
    cancelledCount: number;
    refundedCount: number;
    reviewCount: number;
    recentReviewCount: number;
    disputeCount: number;
    reportCount: number;
    activeProducts: number;
    productSales: number;
    productViews: number;
    repeatBuyerCount: number;
    ageDays: number;
    deliveryRate: number;
    cancellationRate: number;
    refundRate: number;
    disputeRate: number;
    repeatBuyerRate: number;
    conversionRate: number;
    avgResponseTime: number;
    responseCount: number;
    bayesianRating: number;
  };
};

export type TrustScoreResult = {
  storeId: string;
  score: number;
  rating: number;
  level: TrustLevel;
  breakdown: TrustBreakdown;
};

declare global {
  var trustScoreCronStarted: boolean | undefined;
}

const TRUST_TIMEZONE = process.env.TRUST_SCORE_TIMEZONE || 'Asia/Kolkata';
const TRUST_LOCK_TTL_SECONDS = 60 * 25;
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const DAILY_CRON = process.env.TRUST_SCORE_DAILY_CRON || '0 2 * * *';
const RECENT_CRON = process.env.TRUST_SCORE_RECENT_CRON || '*/30 * * * *';
const tasks = new Map<string, ScheduledTask>();
const runningJobs = new Map<string, boolean>();
const lastRun = new Map<string, string>();
const lastError = new Map<string, string>();

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const round = (value: number, decimals = 2) => {
  const factor = Math.pow(10, decimals);
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
};

const safeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const daysBetween = (from?: Date | string | null, to = new Date()) => {
  if (!from) return 0;
  const start = new Date(from).getTime();
  const end = to.getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, (end - start) / 86_400_000);
};

const getTrustLevel = (score: number): TrustLevel => {
  if (score >= 90) return 'elite';
  if (score >= 78) return 'premium';
  if (score >= 62) return 'trusted';
  if (score >= 40) return 'rising';
  return 'new';
};

const calculateBayesianRating = (avgRating: number, reviewCount: number) => {
  const globalAverage = 4.1;
  const minimumConfidenceReviews = 25;
  return ((avgRating * reviewCount) + (globalAverage * minimumConfidenceReviews)) / (reviewCount + minimumConfidenceReviews);
};

const lockKey = (name: string) => `trust_score:lock:${name}`;

async function acquireLock(name: string, ttl = TRUST_LOCK_TTL_SECONDS) {
  const result = await redis.set(lockKey(name), String(Date.now()), 'EX', ttl, 'NX').catch(() => null);
  return !!result;
}

async function releaseLock(name: string) {
  await redis.del(lockKey(name)).catch(() => undefined);
}

async function runJob<T>(name: string, task: () => Promise<T>) {
  if (runningJobs.get(name)) return { skipped: true, reason: 'local_running' };

  const locked = await acquireLock(name);
  if (!locked) return { skipped: true, reason: 'distributed_locked' };

  runningJobs.set(name, true);

  try {
    const result = await task();
    lastRun.set(name, new Date().toISOString());
    lastError.delete(name);
    return result;
  } catch (error: any) {
    lastError.set(name, error?.message || 'unknown_error');
    console.error(`${name} error:`, error);
    return { failed: true, reason: error?.message || 'unknown_error' };
  } finally {
    runningJobs.set(name, false);
    await releaseLock(name);
  }
}

async function safeCount(modelName: string, args: any) {
  const model = (prisma as any)[modelName];
  if (!model?.count) return 0;
  return model.count(args).catch(() => 0);
}

async function safeAggregate(modelName: string, args: any, fallback: any) {
  const model = (prisma as any)[modelName];
  if (!model?.aggregate) return fallback;
  return model.aggregate(args).catch(() => fallback);
}

async function safeGroupBy(modelName: string, args: any) {
  const model = (prisma as any)[modelName];
  if (!model?.groupBy) return [];
  return model.groupBy(args).catch(() => []);
}

async function updateStoreTrustData(storeId: string, data: any) {
  const storeModel = (prisma as any).store;
  if (!storeModel?.update) return null;

  return storeModel.update({
    where: { id: storeId },
    data
  }).catch(async () => {
    const safeData = Object.fromEntries(
      Object.entries(data).filter(([key]) =>
        [
          'trustScore',
          'rating',
          'trustLevel',
          'trustBreakdown',
          'totalOrders',
          'totalRevenue',
          'reviewCount',
          'disputeCount',
          'lastTrustCalculatedAt'
        ].includes(key)
      )
    );

    return storeModel.update({
      where: { id: storeId },
      data: safeData
    }).catch(() => null);
  });
}

export async function calculateTrustScoreDetailed(storeId: string): Promise<TrustScoreResult> {
  if (!storeId || typeof storeId !== 'string') throw new Error('Invalid storeId');

  const now = new Date();
  const last30Days = new Date(now.getTime() - 30 * 86_400_000);
  const last90Days = new Date(now.getTime() - 90 * 86_400_000);

  const store = await (prisma as any).store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      isVerified: true,
      createdAt: true,
      status: true,
      rating: true,
      trustScore: true
    }
  });

  if (!store) throw new Error('Store not found');

  const [
    orderStats,
    recentOrderStats,
    deliveredCount,
    cancelledCount,
    refundedCount,
    reviewStats,
    recentReviewStats,
    disputeCount,
    recentDisputeCount,
    reportCount,
    productStats,
    repeatBuyers,
    responseStats
  ] = await Promise.all([
    safeAggregate('order', {
      where: { storeId },
      _count: true,
      _sum: { total: true },
      _avg: { total: true }
    }, { _count: 0, _sum: { total: 0 }, _avg: { total: 0 } }),
    safeAggregate('order', {
      where: { storeId, createdAt: { gte: last30Days } },
      _count: true,
      _sum: { total: true }
    }, { _count: 0, _sum: { total: 0 } }),
    safeCount('order', {
      where: { storeId, status: { in: ['delivered', 'DELIVERED'] } }
    }),
    safeCount('order', {
      where: { storeId, status: { in: ['cancelled', 'CANCELLED'] } }
    }),
    safeCount('order', {
      where: {
        storeId,
        OR: [
          { status: { in: ['refunded', 'REFUNDED'] } },
          { paymentStatus: { in: ['refunded', 'REFUNDED'] } }
        ]
      }
    }),
    safeAggregate('storeReview', {
      where: { storeId },
      _count: true,
      _avg: { rating: true }
    }, { _count: 0, _avg: { rating: 0 } }),
    safeAggregate('storeReview', {
      where: { storeId, createdAt: { gte: last90Days } },
      _count: true,
      _avg: { rating: true }
    }, { _count: 0, _avg: { rating: 0 } }),
    safeCount('dispute', {
      where: {
        storeId,
        status: { in: ['open', 'actioned', 'resolved_against_seller', 'OPEN', 'ACTIONED', 'RESOLVED_AGAINST_SELLER'] }
      }
    }),
    safeCount('dispute', {
      where: {
        storeId,
        createdAt: { gte: last90Days },
        status: { in: ['open', 'actioned', 'resolved_against_seller', 'OPEN', 'ACTIONED', 'RESOLVED_AGAINST_SELLER'] }
      }
    }),
    safeCount('report', {
      where: {
        targetType: 'store',
        targetId: storeId,
        status: 'actioned'
      }
    }),
    safeAggregate('product', {
      where: {
        storeId,
        status: { in: ['active', 'ACTIVE'] }
      },
      _count: true,
      _sum: {
        salesCount: true,
        viewCount: true
      }
    }, { _count: 0, _sum: { salesCount: 0, viewCount: 0 } }),
    safeGroupBy('order', {
      by: ['buyerId'],
      where: { storeId },
      _count: { buyerId: true },
      having: {
        buyerId: {
          _count: {
            gt: 1
          }
        }
      }
    }),
    safeAggregate('message', {
      where: {
        storeId,
        createdAt: { gte: last90Days }
      },
      _avg: { responseTimeMinutes: true },
      _count: true
    }, { _avg: { responseTimeMinutes: null }, _count: 0 })
  ]);

  const orderCount = safeNumber(orderStats?._count);
  const recentOrderCount = safeNumber(recentOrderStats?._count);
  const totalRevenue = safeNumber(orderStats?._sum?.total);
  const recentRevenue = safeNumber(recentOrderStats?._sum?.total);
  const avgRatingRaw = safeNumber(reviewStats?._avg?.rating);
  const reviewCount = safeNumber(reviewStats?._count);
  const recentAvgRating = safeNumber(recentReviewStats?._avg?.rating, avgRatingRaw);
  const recentReviewCount = safeNumber(recentReviewStats?._count);
  const bayesianRating = calculateBayesianRating(avgRatingRaw || 0, reviewCount);
  const ageDays = daysBetween(store.createdAt, now);
  const activeProducts = safeNumber(productStats?._count);
  const productSales = safeNumber(productStats?._sum?.salesCount);
  const productViews = safeNumber(productStats?._sum?.viewCount);
  const conversionRate = productViews > 0 ? productSales / productViews : 0;
  const cancellationRate = orderCount > 0 ? cancelledCount / orderCount : 0;
  const refundRate = orderCount > 0 ? refundedCount / orderCount : 0;
  const deliveryRate = orderCount > 0 ? deliveredCount / orderCount : 0;
  const disputeRate = orderCount > 0 ? (disputeCount + reportCount) / orderCount : 0;
  const repeatBuyerCount = Array.isArray(repeatBuyers) ? repeatBuyers.length : 0;
  const repeatBuyerRate = orderCount > 0 ? repeatBuyerCount / Math.max(1, orderCount) : 0;
  const avgResponseTime = safeNumber(responseStats?._avg?.responseTimeMinutes, 0);
  const responseCount = safeNumber(responseStats?._count, 0);

  const orderVolumeScore = clamp(Math.log10(orderCount + 1) * 14, 0, 18);
  const revenueScore = clamp(Math.log10(totalRevenue + 1) * 4.5, 0, 12);
  const ratingScore = clamp((bayesianRating / 5) * 24, 0, 24);
  const reviewConfidenceScore = clamp(Math.log10(reviewCount + 1) * 6, 0, 8);
  const deliveryScore = clamp(deliveryRate * 10, 0, 10);
  const cancellationScore = clamp((1 - cancellationRate) * 7, 0, 7);
  const verificationBonus = store.isVerified ? 8 : 0;
  const ageBonus = clamp((ageDays / 365) * 5, 0, 5);
  const activityBonus = clamp(Math.log10(recentOrderCount + recentRevenue + 1) * 2.5, 0, 5);
  const responseBonus = responseCount === 0 ? 1 : clamp(5 - avgResponseTime / 120, 0, 5);
  const repeatBuyerBonus = clamp(repeatBuyerRate * 8, 0, 4);
  const productHealthBonus = clamp(activeProducts * 0.25 + conversionRate * 25, 0, 4);

  const disputePenalty = clamp((disputeCount * 7) + (recentDisputeCount * 4) + disputeRate * 35, 0, 25);
  const refundPenalty = clamp(refundRate * 20, 0, 10);
  const reportPenalty = clamp(reportCount * 5, 0, 20);
  const status = String(store.status || '').toLowerCase();
  const inactivePenalty = status === 'disabled' ? 40 : status === 'suspended' ? 55 : 0;
  const recentRatingPenalty = recentReviewCount >= 3 && recentAvgRating < 3.5 ? clamp((3.5 - recentAvgRating) * 8, 0, 12) : 0;
  const riskPenalty = clamp(disputePenalty + refundPenalty + reportPenalty + inactivePenalty + recentRatingPenalty, 0, 60);

  const rawScore =
    orderVolumeScore +
    revenueScore +
    ratingScore +
    reviewConfidenceScore +
    deliveryScore +
    cancellationScore +
    verificationBonus +
    ageBonus +
    activityBonus +
    responseBonus +
    repeatBuyerBonus +
    productHealthBonus -
    riskPenalty;

  const score = round(clamp(rawScore, 0, 100));
  const rating = round(reviewCount > 0 ? avgRatingRaw : 0);
  const level = getTrustLevel(score);

  const breakdown: TrustBreakdown = {
    score,
    rating,
    level,
    orderVolumeScore: round(orderVolumeScore),
    revenueScore: round(revenueScore),
    ratingScore: round(ratingScore),
    reviewConfidenceScore: round(reviewConfidenceScore),
    deliveryScore: round(deliveryScore),
    cancellationScore: round(cancellationScore),
    disputePenalty: round(disputePenalty + reportPenalty),
    refundPenalty: round(refundPenalty),
    verificationBonus: round(verificationBonus),
    ageBonus: round(ageBonus),
    activityBonus: round(activityBonus),
    responseBonus: round(responseBonus),
    repeatBuyerBonus: round(repeatBuyerBonus),
    productHealthBonus: round(productHealthBonus),
    riskPenalty: round(riskPenalty),
    meta: {
      orderCount,
      recentOrderCount,
      totalRevenue,
      recentRevenue,
      deliveredCount,
      cancelledCount,
      refundedCount,
      reviewCount,
      recentReviewCount,
      disputeCount,
      reportCount,
      activeProducts,
      productSales,
      productViews,
      repeatBuyerCount,
      ageDays: round(ageDays),
      deliveryRate: round(deliveryRate, 4),
      cancellationRate: round(cancellationRate, 4),
      refundRate: round(refundRate, 4),
      disputeRate: round(disputeRate, 4),
      repeatBuyerRate: round(repeatBuyerRate, 4),
      conversionRate: round(conversionRate, 4),
      avgResponseTime: round(avgResponseTime),
      responseCount,
      bayesianRating: round(bayesianRating)
    }
  };

  await updateStoreTrustData(storeId, {
    trustScore: score,
    rating,
    trustLevel: level,
    trustBreakdown: breakdown,
    totalOrders: orderCount,
    totalRevenue,
    reviewCount,
    disputeCount: disputeCount + reportCount,
    lastTrustCalculatedAt: now
  });

  return {
    storeId,
    score,
    rating,
    level,
    breakdown
  };
}

export async function calculateTrustScore(storeId: string): Promise<number> {
  const result = await calculateTrustScoreDetailed(storeId);
  return result.score;
}

export async function calculateManyTrustScores(storeIds: string[]) {
  const uniqueIds = [...new Set((storeIds || []).filter(Boolean))];
  const results: Array<{ storeId: string; score: number | null; level: TrustLevel | null; error: string | null }> = [];

  for (const storeId of uniqueIds) {
    try {
      const result = await calculateTrustScoreDetailed(storeId);
      results.push({ storeId, score: result.score, level: result.level, error: null });
    } catch (error: any) {
      results.push({ storeId, score: null, level: null, error: error?.message || 'Failed to calculate trust score' });
    }
  }

  return results;
}

export async function recalculateAllTrustScores(batchSize = 100) {
  const safeBatchSize = Math.max(10, Math.min(500, Number(batchSize) || 100));
  let cursor: string | undefined;
  let processed = 0;
  let failed = 0;

  while (true) {
    const stores = await (prisma as any).store.findMany({
      where: {
        NOT: {
          status: {
            in: ['disabled', 'DISABLED']
          }
        }
      },
      select: { id: true },
      take: safeBatchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: {
        id: 'asc'
      }
    }).catch(() => []);

    if (!stores.length) break;

    for (const store of stores) {
      try {
        await calculateTrustScore(store.id);
        processed++;
      } catch {
        failed++;
      }
    }

    cursor = stores[stores.length - 1]?.id;
    if (stores.length < safeBatchSize) break;
  }

  return { processed, failed };
}

export async function recalculateRecentTrustScores(limit = 200) {
  const since = new Date(Date.now() - RECENT_WINDOW_MS);
  const storeModel = (prisma as any).store;

  if (!storeModel?.findMany) return { processed: 0, failed: 0 };

  const stores = await storeModel.findMany({
    where: {
      OR: [
        { updatedAt: { gte: since } },
        { orders: { some: { createdAt: { gte: since } } } },
        { reviews: { some: { createdAt: { gte: since } } } },
        { products: { some: { updatedAt: { gte: since } } } }
      ]
    },
    select: { id: true },
    take: Math.max(1, Math.min(500, Number(limit) || 200))
  }).catch(async () => {
    return storeModel.findMany({
      where: {
        updatedAt: { gte: since }
      },
      select: { id: true },
      take: Math.max(1, Math.min(500, Number(limit) || 200))
    }).catch(() => []);
  });

  const results = await calculateManyTrustScores(stores.map((store: any) => store.id));
  return {
    processed: results.filter(item => item.error === null).length,
    failed: results.filter(item => item.error !== null).length,
    results
  };
}

export async function getStoreTrustSummary(storeId: string) {
  const store = await (prisma as any).store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      name: true,
      slug: true,
      isVerified: true,
      status: true,
      rating: true,
      trustScore: true,
      trustLevel: true,
      trustBreakdown: true,
      totalOrders: true,
      totalRevenue: true,
      reviewCount: true,
      disputeCount: true,
      lastTrustCalculatedAt: true
    }
  }).catch(() => null);

  if (!store) return null;

  if (store.trustScore == null || !store.lastTrustCalculatedAt) {
    return calculateTrustScoreDetailed(storeId);
  }

  return store;
}

export async function getTrustedStores(limit = 50, minScore = 62) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeMinScore = clamp(Number(minScore) || 62, 0, 100);

  return (prisma as any).store.findMany({
    where: {
      trustScore: {
        gte: safeMinScore
      },
      NOT: {
        status: {
          in: ['disabled', 'suspended', 'DISABLED', 'SUSPENDED']
        }
      }
    },
    orderBy: [
      { trustScore: 'desc' },
      { rating: 'desc' },
      { updatedAt: 'desc' }
    ],
    take: safeLimit
  }).catch(() => []);
}

export function initTrustScoreCron() {
  if (global.trustScoreCronStarted) return getTrustScoreCronStatus();

  global.trustScoreCronStarted = true;

  const dailyTask = cron.schedule(
    DAILY_CRON,
    () => {
      void runJob('daily_recalculate_all_trust_scores', () => recalculateAllTrustScores());
    },
    {
      timezone: TRUST_TIMEZONE,
      scheduled: true
    }
  );

  const recentTask = cron.schedule(
    RECENT_CRON,
    () => {
      void runJob('recent_recalculate_trust_scores', () => recalculateRecentTrustScores());
    },
    {
      timezone: TRUST_TIMEZONE,
      scheduled: true
    }
  );

  tasks.set('daily_recalculate_all_trust_scores', dailyTask);
  tasks.set('recent_recalculate_trust_scores', recentTask);

  return getTrustScoreCronStatus();
}

export function stopTrustScoreCron() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
  runningJobs.clear();
  global.trustScoreCronStarted = false;
  return getTrustScoreCronStatus();
}

export function getTrustScoreCronStatus() {
  return {
    initialized: !!global.trustScoreCronStarted,
    timezone: TRUST_TIMEZONE,
    activeJobs: Array.from(tasks.keys()),
    lastRun: Object.fromEntries(Array.from(lastRun.entries())),
    lastError: Object.fromEntries(Array.from(lastError.entries()))
  };
}

export async function runTrustScoreJobNow(name: 'daily' | 'recent') {
  if (name === 'daily') {
    return runJob('manual_daily_recalculate_all_trust_scores', () => recalculateAllTrustScores());
  }

  return runJob('manual_recent_recalculate_trust_scores', () => recalculateRecentTrustScores());
}
