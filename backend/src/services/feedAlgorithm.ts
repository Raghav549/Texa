import { prisma } from '../config/db';
import { cache } from '../config/redis';

interface FeedOptions {
  cursor?: string;
  limit: number;
  category?: string;
  excludeSeen?: boolean;
  language?: string;
  region?: string;
  seed?: string;
  recordImpression?: boolean;
  sessionId?: string;
  mode?: 'for_you' | 'following' | 'trending' | 'fresh';
}

type FeedUser = {
  id: string;
  following?: string[];
  likedReels?: string[];
  watchedCategories?: string[];
  language?: string | null;
  region?: string | null;
  interests?: string[] | null;
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
  visibility?: string | null;
  moderationStatus?: string | null;
  isDraft?: boolean | null;
  flagged?: boolean | null;
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

type ScoreContext = {
  savedIds?: Set<string>;
  progressMap?: Map<string, number>;
  impressedSet?: Set<string>;
  authorSeenCount?: number;
  seed?: string;
  mode?: FeedOptions['mode'];
};

type RankedReel<T = any> = T & {
  rankScore?: number;
  rankSignals?: {
    recency: number;
    quality: number;
    engagement: number;
    authority: number;
    affinity: number;
    exploration: number;
    viral: number;
    penalties: number;
  };
};

const FEED_CACHE_TTL = 12;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_CANDIDATES = 300;
const MIN_CANDIDATES = 40;

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

const normalizeText = (value: unknown) => String(value || '').trim().toLowerCase();

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

const feedCacheKey = (userId: string, options: FeedOptions) =>
  `feed:${userId}:${normalizeText(options.mode || 'for_you')}:${normalizeText(options.cursor || 'first')}:${normalizeText(options.category || 'all')}:${normalizeText(options.language || 'auto')}:${normalizeText(options.region || 'auto')}:${safeNumber(options.limit, DEFAULT_LIMIT)}:${options.excludeSeen ? 1 : 0}:${normalizeText(options.seed || '')}`;

async function safeFindMany(modelName: string, args: any, fallback: any[] = []) {
  const model = (prisma as any)[modelName];
  if (!model?.findMany) return fallback;
  return model.findMany(args).catch(() => fallback);
}

async function safeCreate(modelName: string, args: any) {
  const model = (prisma as any)[modelName];
  if (!model?.create) return null;
  return model.create(args).catch(() => null);
}

async function getCursorDate(cursor?: string) {
  if (!cursor) return null;
  const reel = await prisma.reel.findUnique({
    where: { id: cursor },
    select: { publishedAt: true, createdAt: true }
  }).catch(() => null) as any;
  return reel?.publishedAt || reel?.createdAt || null;
}

async function getFeedUser(userId: string): Promise<FeedUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      following: true,
      likedReels: true,
      watchedCategories: true,
      language: true,
      region: true,
      interests: true
    } as any
  }).catch(() => null) as Promise<FeedUser | null>;
}

async function getSeenIds(userId: string, enabled?: boolean) {
  if (!enabled) return [];
  const rows = await safeFindMany('viewHistory', {
    where: { userId },
    select: { reelId: true },
    orderBy: { watchedAt: 'desc' },
    take: 2000
  });
  return unique(rows.map((item: any) => item.reelId).filter(Boolean));
}

async function getRecentImpressedIds(userId: string) {
  const rows = await safeFindMany('feedImpression', {
    where: { userId },
    select: { reelIds: true },
    orderBy: { timestamp: 'desc' },
    take: 25
  });
  return unique(rows.flatMap((item: any) => Array.isArray(item.reelIds) ? item.reelIds : []).filter(Boolean));
}

async function getSavedIds(userId: string) {
  const rows = await safeFindMany('reelSave', {
    where: { userId },
    select: { reelId: true },
    take: 1000
  });
  return new Set(rows.map((item: any) => item.reelId).filter(Boolean));
}

async function getProgressMap(userId: string) {
  const rows = await safeFindMany('watchProgress', {
    where: { userId },
    select: { reelId: true, progress: true },
    orderBy: { updatedAt: 'desc' },
    take: 1000
  });
  return new Map(rows.map((item: any) => [item.reelId, safeNumber(item.progress)]));
}

function buildCandidateWhere(userId: string, user: FeedUser | null, options: FeedOptions, cursorDate: Date | string | null, seenIds: string[]) {
  const language = options.language || user?.language || undefined;
  const region = options.region || user?.region || undefined;
  const mode = options.mode || 'for_you';
  const following = Array.isArray(user?.following) ? user!.following!.filter(Boolean) : [];

  const where: any = {
    visibility: 'public',
    moderationStatus: 'approved',
    publishedAt: {
      lte: new Date(),
      ...(cursorDate ? { lt: cursorDate } : {})
    },
    isDraft: false,
    userId: { not: userId },
    ...(options.category ? { category: options.category } : {}),
    ...(language ? { language } : {}),
    ...(region ? { OR: [{ region }, { region: null }] } : {}),
    ...(seenIds.length ? { id: { notIn: seenIds } } : {})
  };

  if (mode === 'following') {
    where.userId = following.length ? { in: following } : { in: ['__none__'] };
  }

  if (mode === 'fresh') {
    where.publishedAt = {
      ...where.publishedAt,
      gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    };
  }

  return where;
}

function getOrderBy(mode: FeedOptions['mode']) {
  if (mode === 'fresh') {
    return [{ publishedAt: 'desc' }, { createdAt: 'desc' }] as any;
  }

  if (mode === 'trending') {
    return [{ trendingScore: 'desc' }, { publishedAt: 'desc' }] as any;
  }

  return [{ trendingScore: 'desc' }, { publishedAt: 'desc' }] as any;
}

async function getCandidates(userId: string, user: FeedUser | null, options: FeedOptions, cursorDate: Date | string | null, seenIds: string[], candidateLimit: number) {
  const where = buildCandidateWhere(userId, user, options, cursorDate, seenIds);

  let reels = await prisma.reel.findMany({
    where,
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
    orderBy: getOrderBy(options.mode || 'for_you'),
    take: candidateLimit
  }).catch(() => []) as any[];

  if (!reels.length && (options.language || user?.language || options.region || user?.region || options.category)) {
    reels = await prisma.reel.findMany({
      where: {
        visibility: 'public',
        moderationStatus: 'approved',
        publishedAt: {
          lte: new Date(),
          ...(cursorDate ? { lt: cursorDate } : {})
        },
        isDraft: false,
        userId: { not: userId },
        ...(seenIds.length ? { id: { notIn: seenIds } } : {})
      },
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
      orderBy: getOrderBy(options.mode || 'for_you'),
      take: candidateLimit
    }).catch(() => []) as any[];
  }

  return reels;
}

function scoreBreakdown(
  reel: ReelLike,
  userId: string,
  user: FeedUser | null,
  context: ScoreContext = {}
) {
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
  const userFollowing = Array.isArray(user?.following) ? user!.following! : [];
  const userLikedReels = Array.isArray(user?.likedReels) ? user!.likedReels! : [];
  const userWatchedCategories = Array.isArray(user?.watchedCategories) ? user!.watchedCategories! : [];
  const userInterests = Array.isArray(user?.interests) ? user!.interests! : [];
  const isFollowing = userFollowing.includes(reel.userId);
  const isLikedBefore = userLikedReels.includes(reel.id);
  const categoryMatch = !!(reel.category && userWatchedCategories.map(normalizeText).includes(normalizeText(reel.category)));
  const interestMatch = !!(reel.category && userInterests.map(normalizeText).includes(normalizeText(reel.category)));
  const languageMatch = !!(reel.language && user?.language && normalizeText(reel.language) === normalizeText(user.language));
  const regionMatch = !!(reel.region && user?.region && normalizeText(reel.region) === normalizeText(user.region));
  const savedBefore = !!context.savedIds?.has(reel.id);
  const previousProgress = clamp(safeNumber(context.progressMap?.get(reel.id)), 0, 1);
  const impressedBefore = !!context.impressedSet?.has(reel.id);
  const authorSeenCount = safeNumber(context.authorSeenCount);
  const authorAgeHours = hoursSince(reel.author?.createdAt);
  const creatorFreshness = authorAgeHours <= 24 * 14 && followerCount < 1500 ? 1 : 0;
  const velocity = (likes * 1.4 + comments * 2.5 + shares * 3.2 + saves * 2.2 + uniqueViews * 0.08) / Math.pow(hoursOld + 2, 0.82);
  const recency = context.mode === 'fresh' ? 130 * Math.exp(-hoursOld / 72) : 90 * Math.exp(-hoursOld / 36);
  const quality = sigmoid((completionRate - 0.42) * 6) * 55 + sigmoid((avgWatchPercent - 0.5) * 5) * 35;
  const engagement = sigmoid((engagementRate - 0.035) * 16) * 65;
  const authority = (reel.author?.isVerified ? 16 : 0) + logBoost(followerCount, 8);
  const affinity = (isFollowing ? 42 : 0) + (categoryMatch ? 22 : 0) + (interestMatch ? 16 : 0) + (languageMatch ? 10 : 0) + (regionMatch ? 8 : 0) + (isLikedBefore ? 8 : 0) + (savedBefore ? 10 : 0);
  const exploration = creatorFreshness ? 14 : 0;
  const viral = sigmoid(viralCoefficient - 1) * 24 + logBoost(trendingScore, 7) + velocity * 9;
  const saturationPenalty = impressedBefore ? 45 : 0;
  const progressPenalty = previousProgress >= 0.85 ? 35 : previousProgress >= 0.5 ? 18 : 0;
  const diversityPenalty = Math.pow(authorSeenCount, 1.55) * 18;
  const oldContentPenalty = hoursOld > 24 * 21 ? Math.min(60, (hoursOld - 24 * 21) / 24) : 0;
  const modeBoost = context.mode === 'trending' ? logBoost(trendingScore, 12) : context.mode === 'following' && isFollowing ? 35 : 0;
  const randomizer = seededNoise(`${context.seed || ''}:${reel.id}:${userId}`) * 4;
  const penalties = saturationPenalty + progressPenalty + diversityPenalty + oldContentPenalty;

  return {
    recency,
    quality,
    engagement,
    authority,
    affinity,
    exploration,
    viral: viral + modeBoost + randomizer,
    penalties
  };
}

function calculateReelScore(
  reel: ReelLike,
  userId: string,
  user: FeedUser | null,
  context?: ScoreContext
): number {
  const breakdown = scoreBreakdown(reel, userId, user, context || {});
  return Math.max(
    0,
    breakdown.recency +
      breakdown.quality +
      breakdown.engagement +
      breakdown.authority +
      breakdown.affinity +
      breakdown.exploration +
      breakdown.viral -
      breakdown.penalties
  );
}

function rankReels(reels: any[], userId: string, user: FeedUser | null, options: FeedOptions, savedIds: Set<string>, progressMap: Map<string, number>, impressedSet: Set<string>) {
  const authorFrequency = new Map<string, number>();
  const seed = options.seed || `${userId}:${new Date().toISOString().slice(0, 10)}:${options.mode || 'for_you'}`;

  return reels
    .map((reel) => {
      const authorId = reel.userId || reel.author?.id || '';
      const authorSeenCount = authorFrequency.get(authorId) || 0;
      authorFrequency.set(authorId, authorSeenCount + 1);

      const context = {
        savedIds,
        progressMap,
        impressedSet,
        authorSeenCount,
        seed,
        mode: options.mode || 'for_you'
      };

      const rankSignals = scoreBreakdown(reel, userId, user, context);
      const rankScore = calculateReelScore(reel, userId, user, context);

      return {
        reel: {
          ...reel,
          rankScore: Number(rankScore.toFixed(4)),
          rankSignals: {
            recency: Number(rankSignals.recency.toFixed(4)),
            quality: Number(rankSignals.quality.toFixed(4)),
            engagement: Number(rankSignals.engagement.toFixed(4)),
            authority: Number(rankSignals.authority.toFixed(4)),
            affinity: Number(rankSignals.affinity.toFixed(4)),
            exploration: Number(rankSignals.exploration.toFixed(4)),
            viral: Number(rankSignals.viral.toFixed(4)),
            penalties: Number(rankSignals.penalties.toFixed(4))
          }
        } as RankedReel,
        score: rankScore
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function recordFeedImpression(userId: string, reelIds: string[], options: FeedOptions) {
  if (!options.recordImpression || !reelIds.length) return null;

  return safeCreate('feedImpression', {
    data: {
      userId,
      reelIds,
      sessionId: options.sessionId || null,
      source: options.mode || 'for_you',
      timestamp: new Date(),
      metadata: {
        category: options.category || null,
        language: options.language || null,
        region: options.region || null,
        seed: options.seed || null
      }
    } as any
  });
}

export async function generateFeedRanking(userId: string, options: FeedOptions) {
  if (!userId) throw new Error('userId is required');

  const limit = clamp(Math.floor(safeNumber(options.limit, DEFAULT_LIMIT)), 1, MAX_LIMIT);
  const candidateLimit = clamp(limit * 8, MIN_CANDIDATES, MAX_CANDIDATES);
  const normalizedOptions: FeedOptions = {
    ...options,
    limit,
    mode: options.mode || 'for_you'
  };

  const cacheKey = feedCacheKey(userId, normalizedOptions);
  const cached = await cache?.get<any[]>(cacheKey).catch(() => null);
  if (cached && !normalizedOptions.recordImpression) return cached;

  const cursorDate = await getCursorDate(normalizedOptions.cursor);
  const user = await getFeedUser(userId);

  const [seenIds, recentlyImpressedIds, savedIds, progressMap] = await Promise.all([
    getSeenIds(userId, normalizedOptions.excludeSeen),
    getRecentImpressedIds(userId),
    getSavedIds(userId),
    getProgressMap(userId)
  ]);

  const reels = await getCandidates(userId, user, normalizedOptions, cursorDate, seenIds, candidateLimit);
  const impressedSet = new Set(recentlyImpressedIds);
  const ranked = rankReels(reels, userId, user, normalizedOptions, savedIds, progressMap, impressedSet)
    .slice(0, limit)
    .map(item => item.reel);

  await Promise.all([
    cache?.set(cacheKey, ranked, FEED_CACHE_TTL).catch(() => undefined),
    recordFeedImpression(userId, ranked.map((item: any) => item.id).filter(Boolean), normalizedOptions)
  ]);

  return ranked;
}

export async function generateFeedPage(userId: string, options: FeedOptions) {
  const items = await generateFeedRanking(userId, options);
  const last = items[items.length - 1] as any;

  return {
    items,
    nextCursor: last?.id || null,
    hasMore: items.length >= clamp(Math.floor(safeNumber(options.limit, DEFAULT_LIMIT)), 1, MAX_LIMIT)
  };
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

export async function refreshReelTrendingScore(reelId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
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
    }
  }).catch(() => null) as any;

  if (!reel) return null;

  const trendingScore = calculateTrendingScore(reel);

  return prisma.reel.update({
    where: { id: reelId },
    data: { trendingScore } as any
  });
}

export async function refreshManyTrendingScores(limit = 500) {
  const reels = await prisma.reel.findMany({
    where: {
      visibility: 'public',
      moderationStatus: 'approved',
      isDraft: false,
      publishedAt: {
        gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        lte: new Date()
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
      publishedAt: 'desc'
    },
    take: clamp(Math.floor(safeNumber(limit, 500)), 1, 2000)
  }).catch(() => []) as any[];

  const updates = reels.map(reel => prisma.reel.update({
    where: { id: reel.id },
    data: { trendingScore: calculateTrendingScore(reel) } as any
  }).catch(() => null));

  const result = await Promise.all(updates);

  return {
    scanned: reels.length,
    updated: result.filter(Boolean).length
  };
}

export async function clearFeedCache(userId?: string) {
  if (!cache) return true;
  if (!userId) return true;
  const keys = [
    `feed:${userId}:for_you:first:all:auto:auto:10:0:`,
    `feed:${userId}:trending:first:all:auto:auto:10:0:`,
    `feed:${userId}:following:first:all:auto:auto:10:0:`,
    `feed:${userId}:fresh:first:all:auto:auto:10:0:`
  ];
  await Promise.all(keys.map(key => cache.delete(key).catch(() => undefined)));
  return true;
}
