import { prisma } from '../config/db';
import cron from 'node-cron';

type TrustBreakdown = {
  score: number;
  rating: number;
  level: 'new' | 'rising' | 'trusted' | 'premium' | 'elite';
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
  riskPenalty: number;
};

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

const getTrustLevel = (score: number): TrustBreakdown['level'] => {
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

export async function calculateTrustScore(storeId: string): Promise<number> {
  const now = new Date();
  const last30Days = new Date(now.getTime() - 30 * 86_400_000);
  const last90Days = new Date(now.getTime() - 90 * 86_400_000);

  const [
    store,
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
    prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        isVerified: true,
        createdAt: true,
        status: true,
        rating: true,
        trustScore: true
      }
    }),
    prisma.order.aggregate({
      where: { storeId },
      _count: true,
      _sum: { total: true },
      _avg: { total: true }
    }),
    prisma.order.aggregate({
      where: { storeId, createdAt: { gte: last30Days } },
      _count: true,
      _sum: { total: true }
    }),
    prisma.order.count({
      where: { storeId, status: 'delivered' }
    }),
    prisma.order.count({
      where: { storeId, status: 'cancelled' }
    }),
    prisma.order.count({
      where: { storeId, OR: [{ status: 'refunded' }, { paymentStatus: 'refunded' }] }
    }),
    prisma.storeReview.aggregate({
      where: { storeId },
      _count: true,
      _avg: { rating: true }
    }),
    prisma.storeReview.aggregate({
      where: { storeId, createdAt: { gte: last90Days } },
      _count: true,
      _avg: { rating: true }
    }),
    prisma.dispute.count({
      where: { storeId, status: { in: ['open', 'actioned', 'resolved_against_seller'] } }
    }).catch(() => 0),
    prisma.dispute.count({
      where: { storeId, createdAt: { gte: last90Days }, status: { in: ['open', 'actioned', 'resolved_against_seller'] } }
    }).catch(() => 0),
    prisma.report.count({
      where: { targetType: 'store', targetId: storeId, status: 'actioned' }
    }),
    prisma.product.aggregate({
      where: { storeId, status: 'active' },
      _count: true,
      _sum: { salesCount: true, viewCount: true }
    }),
    prisma.order.groupBy({
      by: ['buyerId'],
      where: { storeId },
      _count: { buyerId: true },
      having: { buyerId: { _count: { gt: 1 } } }
    }).catch(() => []),
    prisma.message.aggregate({
      where: { storeId, createdAt: { gte: last90Days } },
      _avg: { responseTimeMinutes: true },
      _count: true
    }).catch(() => ({ _avg: { responseTimeMinutes: null }, _count: 0 }))
  ]);

  if (!store) {
    throw new Error('Store not found');
  }

  const orderCount = safeNumber(orderStats._count);
  const recentOrderCount = safeNumber(recentOrderStats._count);
  const totalRevenue = safeNumber(orderStats._sum.total);
  const recentRevenue = safeNumber(recentOrderStats._sum.total);
  const avgRatingRaw = safeNumber(reviewStats._avg.rating);
  const reviewCount = safeNumber(reviewStats._count);
  const recentAvgRating = safeNumber(recentReviewStats._avg.rating, avgRatingRaw);
  const recentReviewCount = safeNumber(recentReviewStats._count);
  const bayesianRating = calculateBayesianRating(avgRatingRaw || 0, reviewCount);
  const ageDays = daysBetween(store.createdAt, now);
  const activeProducts = safeNumber(productStats._count);
  const productSales = safeNumber(productStats._sum.salesCount);
  const productViews = safeNumber(productStats._sum.viewCount);
  const conversionRate = productViews > 0 ? productSales / productViews : 0;
  const cancellationRate = orderCount > 0 ? cancelledCount / orderCount : 0;
  const refundRate = orderCount > 0 ? refundedCount / orderCount : 0;
  const deliveryRate = orderCount > 0 ? deliveredCount / orderCount : 0;
  const disputeRate = orderCount > 0 ? (disputeCount + reportCount) / orderCount : 0;
  const repeatBuyerCount = Array.isArray(repeatBuyers) ? repeatBuyers.length : 0;
  const repeatBuyerRate = orderCount > 0 ? repeatBuyerCount / Math.max(1, orderCount) : 0;
  const avgResponseTime = safeNumber((responseStats as any)?._avg?.responseTimeMinutes, 0);
  const responseCount = safeNumber((responseStats as any)?._count, 0);

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
  const inactivePenalty = store.status === 'disabled' ? 40 : store.status === 'suspended' ? 55 : 0;
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

  const breakdown: TrustBreakdown = {
    score,
    rating,
    level: getTrustLevel(score),
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
    riskPenalty: round(riskPenalty)
  };

  await prisma.store.update({
    where: { id: storeId },
    data: {
      trustScore: score,
      rating,
      trustLevel: breakdown.level,
      trustBreakdown: breakdown,
      totalOrders: orderCount,
      totalRevenue,
      reviewCount,
      disputeCount: disputeCount + reportCount,
      lastTrustCalculatedAt: now
    }
  });

  return score;
}

export async function calculateManyTrustScores(storeIds: string[]) {
  const uniqueIds = [...new Set(storeIds.filter(Boolean))];
  const results: Array<{ storeId: string; score: number | null; error: string | null }> = [];

  for (const storeId of uniqueIds) {
    try {
      const score = await calculateTrustScore(storeId);
      results.push({ storeId, score, error: null });
    } catch (error: any) {
      results.push({ storeId, score: null, error: error?.message || 'Failed to calculate trust score' });
    }
  }

  return results;
}

export async function recalculateAllTrustScores(batchSize = 100) {
  let cursor: string | undefined;
  let processed = 0;
  let failed = 0;

  while (true) {
    const stores = await prisma.store.findMany({
      where: { status: { not: 'disabled' } },
      select: { id: true },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });

    if (stores.length === 0) break;

    for (const store of stores) {
      try {
        await calculateTrustScore(store.id);
        processed++;
      } catch {
        failed++;
      }
    }

    cursor = stores[stores.length - 1]?.id;
    if (stores.length < batchSize) break;
  }

  return { processed, failed };
}

export function initTrustScoreCron() {
  cron.schedule('0 2 * * *', async () => {
    await recalculateAllTrustScores();
  });

  cron.schedule('*/30 * * * *', async () => {
    const recent = await prisma.store.findMany({
      where: {
        OR: [
          { updatedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
          { orders: { some: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } } },
          { reviews: { some: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } } }
        ]
      },
      select: { id: true },
      take: 200
    }).catch(() => []);

    await calculateManyTrustScores(recent.map(store => store.id));
  });
}
