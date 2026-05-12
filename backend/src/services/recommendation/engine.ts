import { prisma } from '../../config/db';
import { redis, cache } from '../../config/redis';

type InteractionType = 'watch' | 'like' | 'save' | 'share' | 'skip' | 'comment' | 'follow' | 'not_interested';

interface FeedReason {
  type: string;
  weight: number;
}

interface RankedReel {
  score: number;
  reasons: FeedReason[];
  [key: string]: any;
}

interface FeedOptions {
  limit?: number;
  cursor?: string | null;
  category?: string | null;
  excludeSeen?: boolean;
  freshnessHours?: number;
}

const FEED_CACHE_TTL = 300;
const INTERACTION_TTL = 86400 * 14;
const MAX_CANDIDATES = 250;
const MIN_SCORE = 5;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const safeArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const getTimeBucket = (ms = 300000) => Date.now() - (Date.now() % ms);

const uniqueById = <T extends { id: string }>(items: T[]) => {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
};

const shuffleLightly = <T extends RankedReel>(items: T[]) => {
  return items
    .map(item => ({ item, jitter: Math.random() * 3 }))
    .sort((a, b) => (b.item.score + b.jitter) - (a.item.score + a.jitter))
    .map(({ item }) => item);
};

async function getRecentInteractions(userId: string) {
  const raw = await redis.zrevrange(`interaction:${userId}`, 0, 500, 'WITHSCORES');
  const interactions: Array<{ reelId: string; type: InteractionType; value: number; at?: number }> = [];

  for (let i = 0; i < raw.length; i += 2) {
    const [reelId, type, at] = raw[i].split(':');
    interactions.push({
      reelId,
      type: type as InteractionType,
      value: Number(raw[i + 1]) || 0,
      at: at ? Number(at) : undefined
    });
  }

  return interactions;
}

async function getUserSignals(userId: string) {
  const [user, interactions] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        following: true,
        likedReels: true,
        savedReels: true,
        watchHistory: true,
        interests: true,
        blockedUsers: true,
        mutedUsers: true,
        language: true,
        location: true
      }
    }),
    getRecentInteractions(userId)
  ]);

  const watchedReelIds = new Set<string>();
  const likedReelIds = new Set<string>(safeArray<string>(user?.likedReels));
  const savedReelIds = new Set<string>(safeArray<string>(user?.savedReels));
  const followedCreators = new Set<string>(safeArray<string>(user?.following));
  const blockedUsers = new Set<string>(safeArray<string>(user?.blockedUsers));
  const mutedUsers = new Set<string>(safeArray<string>(user?.mutedUsers));
  const categoryAffinity = new Map<string, number>();
  const creatorAffinity = new Map<string, number>();
  const negativeReels = new Set<string>();

  for (const h of safeArray<any>(user?.watchHistory)) {
    if (h?.reelId) watchedReelIds.add(h.reelId);
    if (h?.category) categoryAffinity.set(h.category, (categoryAffinity.get(h.category) || 0) + clamp(Number(h.progress || 0.3), 0.1, 1.5));
    if (h?.creatorId) creatorAffinity.set(h.creatorId, (creatorAffinity.get(h.creatorId) || 0) + clamp(Number(h.progress || 0.2), 0.1, 1.2));
  }

  for (const interaction of interactions) {
    if (interaction.type === 'watch') watchedReelIds.add(interaction.reelId);
    if (interaction.type === 'skip' || interaction.type === 'not_interested') negativeReels.add(interaction.reelId);
  }

  return {
    user,
    interactions,
    watchedReelIds,
    likedReelIds,
    savedReelIds,
    followedCreators,
    blockedUsers,
    mutedUsers,
    categoryAffinity,
    creatorAffinity,
    negativeReels,
    interests: new Set<string>(safeArray<string>(user?.interests))
  };
}

function scoreReel(reel: any, signals: Awaited<ReturnType<typeof getUserSignals>>, creatorExposure: Map<string, number>) {
  let score = 0;
  const reasons: FeedReason[] = [];

  const add = (type: string, weight: number) => {
    if (!Number.isFinite(weight) || weight === 0) return;
    score += weight;
    reasons.push({ type, weight: Number(weight.toFixed(2)) });
  };

  const likes = safeArray<string>(reel.likes).length || reel._count?.likes || 0;
  const comments = safeArray<any>(reel.comments).length || reel._count?.comments || 0;
  const shares = Number(reel.shares || 0);
  const saves = Number(reel.saves || reel._count?.saves || 0);
  const views = Number(reel.views || 0);
  const completionRate = clamp(Number(reel.completionRate || reel.avgCompletionRate || 0), 0, 1);

  const publishedAt = reel.publishedAt || reel.createdAt || new Date();
  const hoursOld = Math.max((Date.now() - new Date(publishedAt).getTime()) / 3600000, 0.25);
  const ageDays = hoursOld / 24;

  if (signals.followedCreators.has(reel.userId)) add('following_creator', 32);
  if (signals.creatorAffinity.has(reel.userId)) add('creator_affinity', clamp((signals.creatorAffinity.get(reel.userId) || 0) * 12, 4, 24));
  if (reel.category && signals.categoryAffinity.has(reel.category)) add('category_match', clamp((signals.categoryAffinity.get(reel.category) || 0) * 10, 5, 25));
  if (reel.category && signals.interests.has(reel.category)) add('interest_match', 12);

  const reelTags = safeArray<string>(reel.hashtags || reel.tags).map(t => String(t).replace('#', '').toLowerCase());
  const interestMatches = reelTags.filter(tag => signals.interests.has(tag)).length;
  if (interestMatches) add('hashtag_interest_match', clamp(interestMatches * 5, 5, 18));

  const engagement = likes * 1.2 + comments * 2.4 + shares * 3.2 + saves * 2.8;
  const velocity = engagement / Math.max(hoursOld, 1);
  add('engagement_velocity', clamp(velocity * 4, 0, 30));

  const engagementRate = views > 0 ? engagement / views : engagement / 100;
  add('engagement_rate', clamp(engagementRate * 40, 0, 18));

  add('retention_quality', completionRate * 24);

  const freshness = Math.exp(-ageDays / 5) * 18;
  add('freshness', clamp(freshness, 0, 18));

  if (reel.trendingScore) add('trending', clamp(Number(reel.trendingScore) * 0.15, 0, 20));
  if (reel.author?.isVerified || reel.author?.isCreator || reel.author?.trustScore >= 75) add('trusted_creator', 6);
  if (reel.music?.title) add('music_boost', 2);
  if (reel.thumbnailUrl) add('has_thumbnail', 1.5);
  if (reel.caption && String(reel.caption).length > 10) add('caption_quality', 1.5);

  if (signals.watchedReelIds.has(reel.id)) add('already_seen_penalty', -28);
  if (signals.likedReelIds.has(reel.id)) add('already_liked_penalty', -8);
  if (signals.savedReelIds.has(reel.id)) add('already_saved_penalty', -4);
  if (signals.negativeReels.has(reel.id)) add('negative_feedback_penalty', -60);

  const exposure = creatorExposure.get(reel.userId) || 0;
  if (exposure >= 1) add('creator_diversity_penalty', -exposure * 8);

  if (reel.moderationStatus && reel.moderationStatus !== 'approved') add('moderation_penalty', -100);
  if (reel.isDraft) add('draft_penalty', -100);
  if (reel.visibility && reel.visibility !== 'public') add('visibility_penalty', -100);
  if (signals.blockedUsers.has(reel.userId) || signals.mutedUsers.has(reel.userId)) add('blocked_or_muted_penalty', -100);

  return {
    ...reel,
    score: Number(clamp(score, -100, 100).toFixed(2)),
    reasons
  };
}

function diversifyFeed<T extends RankedReel>(items: T[], limit: number) {
  const selected: T[] = [];
  const creatorCount = new Map<string, number>();
  const categoryCount = new Map<string, number>();

  for (const item of items) {
    const creatorId = item.userId || item.author?.id;
    const category = item.category || 'general';
    const cCount = creatorCount.get(creatorId) || 0;
    const catCount = categoryCount.get(category) || 0;

    if (cCount >= 3) continue;
    if (catCount >= Math.ceil(limit * 0.45)) continue;

    selected.push(item);
    creatorCount.set(creatorId, cCount + 1);
    categoryCount.set(category, catCount + 1);

    if (selected.length >= limit) break;
  }

  if (selected.length < limit) {
    for (const item of items) {
      if (!selected.some(s => s.id === item.id)) selected.push(item);
      if (selected.length >= limit) break;
    }
  }

  return selected.slice(0, limit);
}

export async function getPersonalizedFeed(userId: string, options: FeedOptions | number = {}) {
  const normalizedOptions: FeedOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = clamp(Number(normalizedOptions.limit || 20), 1, 50);
  const cursor = normalizedOptions.cursor || null;
  const category = normalizedOptions.category || null;
  const excludeSeen = normalizedOptions.excludeSeen ?? false;
  const freshnessHours = clamp(Number(normalizedOptions.freshnessHours || 24 * 30), 6, 24 * 120);

  const cacheKey = `feed:personalized:${userId}:${limit}:${cursor || 'first'}:${category || 'all'}:${excludeSeen ? 1 : 0}:${getTimeBucket()}`;
  const cached = await cache.get<RankedReel[]>(cacheKey);
  if (cached) return cached;

  const signals = await getUserSignals(userId);

  const where: any = {
    userId: { not: userId },
    isDraft: false,
    moderationStatus: 'approved',
    visibility: 'public',
    publishedAt: { lte: new Date(), gte: new Date(Date.now() - freshnessHours * 3600000) }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };
  if (category) where.category = category;
  if (signals.blockedUsers.size || signals.mutedUsers.size) {
    where.userId = { notIn: [userId, ...Array.from(signals.blockedUsers), ...Array.from(signals.mutedUsers)] };
  }

  if (excludeSeen && signals.watchedReelIds.size) {
    where.id = { notIn: Array.from(signals.watchedReelIds).slice(0, 1000) };
  }

  const candidates = await prisma.reel.findMany({
    where,
    take: MAX_CANDIDATES,
    orderBy: [
      { trendingScore: 'desc' },
      { createdAt: 'desc' }
    ],
    include: {
      author: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true,
          trustScore: true
        }
      },
      _count: {
        select: {
          comments: true
        }
      }
    }
  });

  const creatorExposure = new Map<string, number>();
  const scored: RankedReel[] = [];

  for (const reel of uniqueById(candidates as any[])) {
    const ranked = scoreReel(reel, signals, creatorExposure);
    if (ranked.score >= MIN_SCORE) {
      scored.push(ranked);
      creatorExposure.set(reel.userId, (creatorExposure.get(reel.userId) || 0) + 1);
    }
  }

  const ranked = diversifyFeed(
    shuffleLightly(scored.sort((a, b) => b.score - a.score)),
    limit
  );

  await cache.set(cacheKey, ranked, FEED_CACHE_TTL);
  return ranked;
}

export async function getFollowingFeed(userId: string, limit = 20, cursor?: string | null) {
  const cacheKey = `feed:following:${userId}:${limit}:${cursor || 'first'}:${getTimeBucket()}`;
  const cached = await cache.get<RankedReel[]>(cacheKey);
  if (cached) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { following: true, blockedUsers: true, mutedUsers: true }
  });

  const following = safeArray<string>(user?.following);
  const blocked = new Set<string>([...safeArray<string>(user?.blockedUsers), ...safeArray<string>(user?.mutedUsers)]);

  if (!following.length) return [];

  const where: any = {
    userId: { in: following.filter(id => !blocked.has(id)) },
    isDraft: false,
    moderationStatus: 'approved',
    visibility: 'public',
    publishedAt: { lte: new Date() }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };

  const reels = await prisma.reel.findMany({
    where,
    take: clamp(limit, 1, 50),
    orderBy: { createdAt: 'desc' },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true,
          trustScore: true
        }
      },
      _count: {
        select: {
          comments: true
        }
      }
    }
  });

  await cache.set(cacheKey, reels, FEED_CACHE_TTL);
  return reels;
}

export async function getTrendingFeed(limit = 20, cursor?: string | null) {
  const cacheKey = `feed:trending:${limit}:${cursor || 'first'}:${getTimeBucket()}`;
  const cached = await cache.get<RankedReel[]>(cacheKey);
  if (cached) return cached;

  const where: any = {
    isDraft: false,
    moderationStatus: 'approved',
    visibility: 'public',
    publishedAt: {
      lte: new Date(),
      gte: new Date(Date.now() - 7 * 24 * 3600000)
    }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };

  const reels = await prisma.reel.findMany({
    where,
    take: clamp(limit, 1, 50),
    orderBy: [
      { trendingScore: 'desc' },
      { views: 'desc' },
      { createdAt: 'desc' }
    ],
    include: {
      author: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true,
          trustScore: true
        }
      },
      _count: {
        select: {
          comments: true
        }
      }
    }
  });

  await cache.set(cacheKey, reels, FEED_CACHE_TTL);
  return reels;
}

export async function trackInteraction(
  userId: string,
  reelId: string,
  type: InteractionType,
  duration = 1,
  metadata: Record<string, any> = {}
) {
  const now = Date.now();
  const score =
    type === 'watch' ? clamp(duration, 1, 1000) :
    type === 'like' ? 80 :
    type === 'save' ? 95 :
    type === 'share' ? 100 :
    type === 'comment' ? 90 :
    type === 'follow' ? 100 :
    type === 'skip' ? -40 :
    type === 'not_interested' ? -100 :
    1;

  const key = `interaction:${userId}`;
  const member = `${reelId}:${type}:${now}`;

  await redis
    .multi()
    .zadd(key, score, member)
    .zremrangebyrank(key, 0, -1001)
    .expire(key, INTERACTION_TTL)
    .setex(`interaction:last:${userId}:${reelId}:${type}`, INTERACTION_TTL, JSON.stringify({ duration, metadata, at: now }))
    .exec();

  if (type === 'watch') {
    const progress = clamp(duration, 0, 1);
    await prisma.reelWatch.upsert({
      where: {
        userId_reelId: {
          userId,
          reelId
        }
      },
      update: {
        progress,
        completed: progress >= 0.9,
        watchTime: { increment: Math.round((metadata.watchTime || 0) as number) },
        updatedAt: new Date()
      },
      create: {
        userId,
        reelId,
        progress,
        completed: progress >= 0.9,
        watchTime: Math.round((metadata.watchTime || 0) as number)
      }
    }).catch(() => null);
  }

  await cache.delete(`feed:personalized:${userId}:*`).catch(() => null);

  return { success: true, score };
}

export async function refreshReelTrendingScore(reelId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: {
      id: true,
      likes: true,
      shares: true,
      views: true,
      completionRate: true,
      createdAt: true,
      _count: {
        select: {
          comments: true
        }
      }
    }
  });

  if (!reel) return null;

  const likes = safeArray<string>(reel.likes).length;
  const comments = reel._count?.comments || 0;
  const shares = Number(reel.shares || 0);
  const views = Number(reel.views || 0);
  const completionRate = clamp(Number(reel.completionRate || 0), 0, 1);
  const hoursOld = Math.max((Date.now() - new Date(reel.createdAt).getTime()) / 3600000, 1);

  const engagement = likes * 1.5 + comments * 2.5 + shares * 4 + completionRate * 25;
  const viewQuality = views > 0 ? engagement / Math.sqrt(views) : engagement;
  const freshness = Math.exp(-hoursOld / 72);
  const trendingScore = Number(clamp((viewQuality * freshness) + engagement / Math.max(hoursOld, 1), 0, 1000).toFixed(2));

  await prisma.reel.update({
    where: { id: reelId },
    data: { trendingScore }
  });

  return trendingScore;
}
