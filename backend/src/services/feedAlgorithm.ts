import { prisma } from '../config/db';

interface FeedOptions {
  cursor?: string;
  limit: number;
  category?: string;
  excludeSeen?: boolean;
  language?: string;
  region?: string;
  seed?: string;
}

type FeedUser = {
  id: string;
  following?: string[];
  likedReels?: string[];
  watchedCategories?: string[];
  language?: string | null;
  region?: string | null;
};

type ReelLike = {
  id: string;
  userId: string;
  views?: number | null;
  uniqueViews?: number | null;
  shares?: number | null;
  saves?: string[] | null;
  likes?: string[] | null;
  completionRate?: number | null;
  avgWatchPercent?: number | null;
  engagementRate?: number | null;
  viralCoefficient?: number | null;
  trendingScore?: number | null;
  category?: string | null;
  language?: string | null;
  region?: string | null;
  publishedAt?: Date | string | null;
  createdAt?: Date | string | null;
  author?: {
    id?: string;
    followers?: string[] | null;
    isVerified?: boolean | null;
    createdAt?: Date | string | null;
  } | null;
  _count?: {
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
  } | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const safeDate = (value: Date | string | null | undefined) => {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
};

const safeNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const unique = <T>(items: T[]) => Array.from(new Set(items));

const getCount = (reel: ReelLike, key: 'likes' | 'comments' | 'shares' | 'saves') => {
  if (typeof reel._count?.[key] === 'number') return reel._count[key] || 0;
  if (key === 'likes' && Array.isArray(reel.likes)) return reel.likes.length;
  if (key === 'shares') return safeNumber(reel.shares);
  if (key === 'saves' && Array.isArray(reel.saves)) return reel.saves.length;
  return 0;
};

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

const logBoost = (value: number, multiplier = 1) => Math.log10(Math.max(0, value) + 1) * multiplier;

const hoursSince = (date: Date | string | null | undefined) => {
  const diff = Date.now() - safeDate(date).getTime();
  return Math.max(diff / 3600000, 0.01);
};

const seededNoise = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
};

export async function generateFeedRanking(userId: string, options: FeedOptions) {
  const limit = clamp(Math.floor(safeNumber(options.limit, 10)), 1, 50);
  const candidateLimit = clamp(limit * 8, 40, 300);
  const cursorDate = options.cursor
    ? await prisma.reel.findUnique({ where: { id: options.cursor }, select: { publishedAt: true } }).then((r: any) => r?.publishedAt || null)
    : null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      following: true,
      likedReels: true,
      watchedCategories: true,
      language: true,
      region: true
    } as any
  }) as FeedUser | null;

  const [seenRows, recentAuthorRows, savedRows, progressRows] = await Promise.all([
    options.excludeSeen
      ? prisma.viewHistory.findMany({
          where: { userId },
          select: { reelId: true },
          orderBy: { watchedAt: 'desc' },
          take: 2000
        })
      : Promise.resolve([]),
    prisma.feedImpression.findMany({
      where: { userId },
      select: { reelIds: true },
      orderBy: { timestamp: 'desc' },
      take: 25
    }).catch(() => []),
    prisma.reelSave.findMany({
      where: { userId },
      select: { reelId: true },
      take: 1000
    }).catch(() => []),
    prisma.watchProgress.findMany({
      where: { userId },
      select: { reelId: true, progress: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000
    }).catch(() => [])
  ]);

  const seenIds = unique((seenRows as any[]).map((s) => s.reelId).filter(Boolean));
  const recentlyImpressedIds = unique((recentAuthorRows as any[]).flatMap((r) => Array.isArray(r.reelIds) ? r.reelIds : []).filter(Boolean));
  const savedIds = new Set((savedRows as any[]).map((s) => s.reelId));
  const progressMap = new Map((progressRows as any[]).map((p) => [p.reelId, safeNumber(p.progress)]));

  const candidateWhere: any = {
    visibility: 'public',
    moderationStatus: 'approved',
    publishedAt: {
      lte: new Date(),
      ...(cursorDate ? { lt: cursorDate } : {})
    },
    isDraft: false,
    userId: { not: userId },
    ...(options.category ? { category: options.category } : {}),
    ...(options.language || user?.language ? { language: options.language || user?.language } : {}),
    ...(options.region || user?.region ? { OR: [{ region: options.region || user?.region }, { region: null }] } : {}),
    ...(seenIds.length ? { id: { notIn: seenIds } } : {})
  };

  const reels = await prisma.reel.findMany({
    where: candidateWhere,
    include: {
      author: {
        select: {
          id: true,
          followers: true,
          isVerified: true,
          createdAt: true
        }
      },
      music: true,
      _count: {
        select: {
          likes: true,
          comments: true,
          shares: true,
          saves: true
        } as any
      }
    },
    orderBy: [
      { trendingScore: 'desc' },
      { publishedAt: 'desc' }
    ],
    take: candidateLimit
  }) as any[];

  const authorFrequency = new Map<string, number>();
  const impressedSet = new Set(recentlyImpressedIds);
  const scored = reels.map((reel) => {
    const authorId = reel.userId || reel.author?.id || '';
    const authorSeenCount = authorFrequency.get(authorId) || 0;
    authorFrequency.set(authorId, authorSeenCount + 1);
    const score = calculateReelScore(reel, userId, user, {
      savedIds,
      progressMap,
      impressedSet,
      authorSeenCount,
      seed: options.seed || `${userId}:${new Date().toISOString().slice(0, 10)}`
    });
    return { reel, score };
  });

  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.reel);

  return ranked;
}

function calculateReelScore(
  reel: ReelLike,
  userId: string,
  user: FeedUser | null,
  context?: {
    savedIds?: Set<string>;
    progressMap?: Map<string, number>;
    impressedSet?: Set<string>;
    authorSeenCount?: number;
    seed?: string;
  }
): number {
  const hoursOld = hoursSince(reel.publishedAt || reel.createdAt);
  const views = Math.max(safeNumber(reel.views), 1);
  const uniqueViews = Math.max(safeNumber(reel.uniqueViews), 0);
  const likes = getCount(reel, 'likes');
  const comments = getCount(reel, 'comments');
  const shares = getCount(reel, 'shares');
  const saves = getCount(reel, 'saves');
  const followerCount = Array.isArray(reel.author?.followers) ? reel.author!.followers!.length : 0;
  const engagementRate = reel.engagementRate ?? ((likes * 1.2 + comments * 2.2 + shares * 3 + saves * 2.5) / views);
  const completionRate = clamp(safeNumber(reel.completionRate, 0.45), 0, 1);
  const avgWatchPercent = clamp(safeNumber(reel.avgWatchPercent, completionRate), 0, 1);
  const viralCoefficient = clamp(safeNumber(reel.viralCoefficient), 0, 10);
  const trendingScore = safeNumber(reel.trendingScore);
  const isFollowing = !!user?.following?.includes(reel.userId);
  const isLikedBefore = !!user?.likedReels?.includes(reel.id);
  const categoryMatch = !!(reel.category && user?.watchedCategories?.includes(reel.category));
  const languageMatch = !!(reel.language && user?.language && reel.language === user.language);
  const savedBefore = !!context?.savedIds?.has(reel.id);
  const previousProgress = clamp(safeNumber(context?.progressMap?.get(reel.id)), 0, 1);
  const impressedBefore = !!context?.impressedSet?.has(reel.id);
  const authorSeenCount = safeNumber(context?.authorSeenCount);
  const authorAgeHours = hoursSince(reel.author?.createdAt);
  const creatorFreshness = authorAgeHours <= 24 * 14 && followerCount < 1500 ? 1 : 0;
  const velocity = (likes * 1.4 + comments * 2.5 + shares * 3.2 + saves * 2.2 + uniqueViews * 0.08) / Math.pow(hoursOld + 2, 0.82);
  const recency = 90 * Math.exp(-hoursOld / 36);
  const quality = sigmoid((completionRate - 0.42) * 6) * 55 + sigmoid((avgWatchPercent - 0.5) * 5) * 35;
  const engagement = sigmoid((engagementRate - 0.035) * 16) * 65;
  const authority = (reel.author?.isVerified ? 16 : 0) + logBoost(followerCount, 8);
  const affinity = (isFollowing ? 42 : 0) + (categoryMatch ? 22 : 0) + (languageMatch ? 10 : 0) + (isLikedBefore ? 8 : 0) + (savedBefore ? 10 : 0);
  const exploration = creatorFreshness ? 14 : 0;
  const viral = sigmoid(viralCoefficient - 1) * 24 + logBoost(trendingScore, 7) + velocity * 9;
  const saturationPenalty = impressedBefore ? 45 : 0;
  const progressPenalty = previousProgress >= 0.85 ? 35 : previousProgress >= 0.5 ? 18 : 0;
  const diversityPenalty = Math.pow(authorSeenCount, 1.55) * 18;
  const oldContentPenalty = hoursOld > 24 * 21 ? Math.min(60, (hoursOld - 24 * 21) / 24) : 0;
  const randomizer = seededNoise(`${context?.seed || ''}:${reel.id}:${userId}`) * 4;

  return Math.max(
    0,
    recency +
      quality +
      engagement +
      authority +
      affinity +
      exploration +
      viral +
      randomizer -
      saturationPenalty -
      progressPenalty -
      diversityPenalty -
      oldContentPenalty
  );
}

export function calculateTrendingScore(reel: ReelLike): number {
  const publishedAt = reel.publishedAt || reel.createdAt;
  const hours = Math.max(hoursSince(publishedAt), 0.25);
  const views = Math.max(safeNumber(reel.views), 0);
  const uniqueViews = Math.max(safeNumber(reel.uniqueViews), 0);
  const likes = getCount(reel, 'likes');
  const comments = getCount(reel, 'comments');
  const shares = getCount(reel, 'shares');
  const saves = getCount(reel, 'saves');
  const completionRate = clamp(safeNumber(reel.completionRate, 0.5), 0.05, 1);
  const avgWatchPercent = clamp(safeNumber(reel.avgWatchPercent, completionRate), 0.05, 1);
  const engagementVelocity = (likes * 1.4 + comments * 2.4 + shares * 3.5 + saves * 2.2) / Math.pow(hours + 1, 0.78);
  const viewVelocity = (views * 0.18 + uniqueViews * 0.32) / Math.pow(hours + 1, 0.72);
  const retentionMultiplier = 0.55 + completionRate * 0.75 + avgWatchPercent * 0.45;
  const freshnessMultiplier = Math.exp(-hours / 168) + 0.35;
  const authorityPenalty = views > 0 && likes + comments + shares + saves === 0 ? 0.72 : 1;
  const score = (engagementVelocity * 7 + viewVelocity * 2.5) * retentionMultiplier * freshnessMultiplier * authorityPenalty;
  return Number(score.toFixed(4));
}
