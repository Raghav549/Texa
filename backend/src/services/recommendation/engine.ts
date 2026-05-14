import { ModerationStatus } from '@prisma/client';
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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

const safeArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const getTimeBucket = (ms = 300000) => Date.now() - (Date.now() % ms);

const uniqueById = <T extends { id: string }>(items: T[]) => {
  const map = new Map<string, T>();
  for (const item of items) {
    if (item?.id && !map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
};

const normalizeTag = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 80);

const normalizeId = (value: unknown) => String(value || '').trim();

const shuffleLightly = <T extends RankedReel>(items: T[]) => {
  return items
    .map(item => ({ item, jitter: Math.random() * 3 }))
    .sort((a, b) => (b.item.score + b.jitter) - (a.item.score + a.jitter))
    .map(({ item }) => item);
};

const readCache = async <T>(key: string): Promise<T | null> => {
  try {
    const direct = await cache.get<T>(key);
    if (direct) return direct;
  } catch {}

  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
};

const writeCache = async (key: string, value: unknown, ttl = FEED_CACHE_TTL) => {
  try {
    await cache.set(key, value, ttl);
    return;
  } catch {}

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {}
};

const deleteByPattern = async (pattern: string) => {
  const keys: string[] = [];
  const stream = redis.scanStream({ match: pattern, count: 100 });

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (items: string[]) => {
      keys.push(...items);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  }).catch(() => null);

  if (keys.length) {
    await redis.del(...keys).catch(() => null);
  }

  return keys.length;
};

const getRedisSet = async (key: string) => {
  try {
    return new Set((await redis.smembers(key)).map(normalizeId).filter(Boolean));
  } catch {
    return new Set<string>();
  }
};

async function getRecentInteractions(userId: string) {
  const raw = await redis.zrevrange(`interaction:${userId}`, 0, 500, 'WITHSCORES');
  const interactions: Array<{ reelId: string; type: InteractionType; value: number; at?: number }> = [];

  for (let i = 0; i < raw.length; i += 2) {
    const parts = String(raw[i] || '').split(':');
    const reelId = parts[0];
    const type = parts[1] as InteractionType;
    const at = Number(parts[2] || 0);

    if (!reelId || !type) continue;

    interactions.push({
      reelId,
      type,
      value: Number(raw[i + 1]) || 0,
      at: at || undefined
    });
  }

  return interactions;
}

async function getUserSignals(userId: string) {
  const [user, interactions, followingRedis, blockedRedis, mutedRedis, likedRedis, savedRedis, seenRedis] = await Promise.all([
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
      } as any
    }).catch(() => null),
    getRecentInteractions(userId),
    getRedisSet(`user:following:${userId}`),
    getRedisSet(`user:blocked:${userId}`),
    getRedisSet(`user:muted:${userId}`),
    getRedisSet(`user:liked_reels:${userId}`),
    getRedisSet(`user:saved_reels:${userId}`),
    getRedisSet(`feed:seen:${userId}`)
  ]);

  const watchedReelIds = new Set<string>(seenRedis);
  const likedReelIds = new Set<string>([...safeArray<string>((user as any)?.likedReels), ...likedRedis].map(normalizeId).filter(Boolean));
  const savedReelIds = new Set<string>([...safeArray<string>((user as any)?.savedReels), ...savedRedis].map(normalizeId).filter(Boolean));
  const followedCreators = new Set<string>([...safeArray<string>((user as any)?.following), ...followingRedis].map(normalizeId).filter(Boolean));
  const blockedUsers = new Set<string>([...safeArray<string>((user as any)?.blockedUsers), ...blockedRedis].map(normalizeId).filter(Boolean));
  const mutedUsers = new Set<string>([...safeArray<string>((user as any)?.mutedUsers), ...mutedRedis].map(normalizeId).filter(Boolean));
  const categoryAffinity = new Map<string, number>();
  const creatorAffinity = new Map<string, number>();
  const negativeReels = new Set<string>();
  const interests = new Set<string>(safeArray<string>((user as any)?.interests).map(normalizeTag).filter(Boolean));

  for (const h of safeArray<any>((user as any)?.watchHistory)) {
    if (h?.reelId) watchedReelIds.add(normalizeId(h.reelId));
    if (h?.category) {
      const category = normalizeTag(h.category);
      categoryAffinity.set(category, (categoryAffinity.get(category) || 0) + clamp(Number(h.progress || 0.3), 0.1, 1.5));
    }
    if (h?.creatorId) {
      const creatorId = normalizeId(h.creatorId);
      creatorAffinity.set(creatorId, (creatorAffinity.get(creatorId) || 0) + clamp(Number(h.progress || 0.2), 0.1, 1.2));
    }
  }

  for (const interaction of interactions) {
    if (interaction.type === 'watch') watchedReelIds.add(interaction.reelId);
    if (interaction.type === 'like') likedReelIds.add(interaction.reelId);
    if (interaction.type === 'save') savedReelIds.add(interaction.reelId);
    if (interaction.type === 'follow') followedCreators.add(interaction.reelId);
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
    interests
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

  const likes = safeArray<string>(reel.likes).length || reel._count?.likes || Number(reel.likeCount || 0);
  const comments = safeArray<any>(reel.comments).length || reel._count?.comments || Number(reel.commentCount || 0);
  const shares = Number(reel.shares || reel.shareCount || 0);
  const saves = Number(reel.saves || reel._count?.saves || reel.saveCount || 0);
  const views = Number(reel.views || reel.viewCount || 0);
  const completionRate = clamp(Number(reel.completionRate || reel.avgCompletionRate || 0), 0, 1);
  const publishedAt = reel.publishedAt || reel.createdAt || new Date();
  const hoursOld = Math.max((Date.now() - new Date(publishedAt).getTime()) / 3600000, 0.25);
  const ageDays = hoursOld / 24;
  const creatorId = normalizeId(reel.userId || reel.author?.id);

  if (signals.followedCreators.has(creatorId)) add('following_creator', 32);
  if (signals.creatorAffinity.has(creatorId)) add('creator_affinity', clamp((signals.creatorAffinity.get(creatorId) || 0) * 12, 4, 24));

  const category = normalizeTag(reel.category || 'general');

  if (category && signals.categoryAffinity.has(category)) add('category_match', clamp((signals.categoryAffinity.get(category) || 0) * 10, 5, 25));
  if (category && signals.interests.has(category)) add('interest_match', 12);

  const reelTags = safeArray<string>(reel.hashtags || reel.tags).map(normalizeTag).filter(Boolean);
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
  if (reel.music?.title || reel.musicTitle) add('music_boost', 2);
  if (reel.thumbnailUrl || reel.thumbnail) add('has_thumbnail', 1.5);
  if (reel.caption && String(reel.caption).length > 10) add('caption_quality', 1.5);

  if (signals.watchedReelIds.has(reel.id)) add('already_seen_penalty', -28);
  if (signals.likedReelIds.has(reel.id)) add('already_liked_penalty', -8);
  if (signals.savedReelIds.has(reel.id)) add('already_saved_penalty', -4);
  if (signals.negativeReels.has(reel.id)) add('negative_feedback_penalty', -60);

  const exposure = creatorExposure.get(creatorId) || 0;
  if (exposure >= 1) add('creator_diversity_penalty', -exposure * 8);

  if (reel.moderationStatus && reel.moderationStatus !== ModerationStatus.SAFE && reel.moderationStatus !== 'SAFE' && reel.moderationStatus !== 'approved') add('moderation_penalty', -100);
  if (reel.flaggedReason) add('flagged_penalty', -60);
  if (reel.isDraft) add('draft_penalty', -100);
  if (reel.visibility && reel.visibility !== 'public' && reel.visibility !== 'PUBLIC') add('visibility_penalty', -100);
  if (signals.blockedUsers.has(creatorId) || signals.mutedUsers.has(creatorId)) add('blocked_or_muted_penalty', -100);

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
    const creatorId = normalizeId(item.userId || item.author?.id);
    const category = normalizeTag(item.category || 'general');
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

const markFeedSeen = async (userId: string, reels: RankedReel[]) => {
  if (!reels.length) return;

  const now = Date.now();
  const pipeline = redis.pipeline();

  for (const reel of reels) {
    if (reel.id) pipeline.zadd(`feed:seen:${userId}`, now, reel.id);
  }

  pipeline.zremrangebyscore(`feed:seen:${userId}`, 0, now - 14 * 86400 * 1000);
  pipeline.expire(`feed:seen:${userId}`, INTERACTION_TTL);
  await pipeline.exec().catch(() => null);
};

export async function getPersonalizedFeed(userId: string, options: FeedOptions | number = {}) {
  const normalizedOptions: FeedOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = clamp(Number(normalizedOptions.limit || 20), 1, 50);
  const cursor = normalizedOptions.cursor || null;
  const category = normalizedOptions.category || null;
  const excludeSeen = normalizedOptions.excludeSeen ?? false;
  const freshnessHours = clamp(Number(normalizedOptions.freshnessHours || 24 * 30), 6, 24 * 120);
  const cacheKey = `feed:personalized:${userId}:${limit}:${cursor || 'first'}:${category || 'all'}:${excludeSeen ? 1 : 0}:${getTimeBucket()}`;
  const cached = await readCache<RankedReel[]>(cacheKey);

  if (cached) return cached;

  const signals = await getUserSignals(userId);
  const blockedOrMuted = [...signals.blockedUsers, ...signals.mutedUsers].filter(Boolean);

  const where: any = {
    userId: blockedOrMuted.length ? { notIn: [userId, ...blockedOrMuted] } : { not: userId },
    isDraft: false,
    moderationStatus: ModerationStatus.SAFE,
    visibility: 'public',
    publishedAt: {
      lte: new Date(),
      gte: new Date(Date.now() - freshnessHours * 3600000)
    }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };
  if (category) where.category = category;
  if (excludeSeen && signals.watchedReelIds.size) where.id = { notIn: Array.from(signals.watchedReelIds).slice(0, 1000) };

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
      const creatorId = normalizeId(reel.userId || reel.author?.id);
      creatorExposure.set(creatorId, (creatorExposure.get(creatorId) || 0) + 1);
    }
  }

  const ranked = diversifyFeed(shuffleLightly(scored.sort((a, b) => b.score - a.score)), limit);

  await markFeedSeen(userId, ranked);
  await writeCache(cacheKey, ranked, FEED_CACHE_TTL);

  return ranked;
}

export async function getFollowingFeed(userId: string, limit = 20, cursor?: string | null) {
  const finalLimit = clamp(Number(limit || 20), 1, 50);
  const cacheKey = `feed:following:${userId}:${finalLimit}:${cursor || 'first'}:${getTimeBucket()}`;
  const cached = await readCache<RankedReel[]>(cacheKey);

  if (cached) return cached;

  const [user, followingRedis, blockedRedis, mutedRedis] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { following: true, blockedUsers: true, mutedUsers: true } as any
    }).catch(() => null),
    getRedisSet(`user:following:${userId}`),
    getRedisSet(`user:blocked:${userId}`),
    getRedisSet(`user:muted:${userId}`)
  ]);

  const following = [...new Set([...safeArray<string>((user as any)?.following), ...followingRedis].map(normalizeId).filter(Boolean))];
  const blocked = new Set<string>([...safeArray<string>((user as any)?.blockedUsers), ...safeArray<string>((user as any)?.mutedUsers), ...blockedRedis, ...mutedRedis].map(normalizeId).filter(Boolean));

  if (!following.length) return [];

  const where: any = {
    userId: { in: following.filter(id => !blocked.has(id)) },
    isDraft: false,
    moderationStatus: ModerationStatus.SAFE,
    visibility: 'public',
    publishedAt: { lte: new Date() }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };

  const reels = await prisma.reel.findMany({
    where,
    take: finalLimit,
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

  await writeCache(cacheKey, reels, FEED_CACHE_TTL);
  return reels;
}

export async function getTrendingFeed(limit = 20, cursor?: string | null) {
  const finalLimit = clamp(Number(limit || 20), 1, 50);
  const cacheKey = `feed:trending:${finalLimit}:${cursor || 'first'}:${getTimeBucket()}`;
  const cached = await readCache<RankedReel[]>(cacheKey);

  if (cached) return cached;

  const where: any = {
    isDraft: false,
    moderationStatus: ModerationStatus.SAFE,
    visibility: 'public',
    publishedAt: {
      lte: new Date(),
      gte: new Date(Date.now() - 7 * 24 * 3600000)
    }
  };

  if (cursor) where.createdAt = { lt: new Date(cursor) };

  const reels = await prisma.reel.findMany({
    where,
    take: finalLimit,
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

  await writeCache(cacheKey, reels, FEED_CACHE_TTL);
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

  if (type === 'like') await redis.sadd(`user:liked_reels:${userId}`, reelId).catch(() => null);
  if (type === 'save') await redis.sadd(`user:saved_reels:${userId}`, reelId).catch(() => null);
  if (type === 'not_interested' || type === 'skip') await redis.sadd(`user:negative_reels:${userId}`, reelId).catch(() => null);

  if (type === 'watch') {
    const progress = clamp(duration, 0, 1);
    const watchTime = Math.max(0, Math.round(Number(metadata.watchTime || 0)));

    await (prisma as any).reelWatch?.upsert({
      where: {
        userId_reelId: {
          userId,
          reelId
        }
      },
      update: {
        progress,
        completed: progress >= 0.9,
        watchTime: { increment: watchTime },
        updatedAt: new Date()
      },
      create: {
        userId,
        reelId,
        progress,
        completed: progress >= 0.9,
        watchTime
      }
    }).catch(() => null);

    await redis.zadd(`feed:seen:${userId}`, now, reelId).catch(() => null);
    await redis.expire(`feed:seen:${userId}`, INTERACTION_TTL).catch(() => null);
  }

  await deleteByPattern(`feed:personalized:${userId}:*`).catch(() => null);
  await refreshReelTrendingScore(reelId).catch(() => null);

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
    } as any
  });

  if (!reel) return null;

  const likes = safeArray<string>((reel as any).likes).length || Number((reel as any).likeCount || 0);
  const comments = (reel as any)._count?.comments || 0;
  const shares = Number((reel as any).shares || (reel as any).shareCount || 0);
  const views = Number((reel as any).views || (reel as any).viewCount || 0);
  const completionRate = clamp(Number((reel as any).completionRate || 0), 0, 1);
  const hoursOld = Math.max((Date.now() - new Date((reel as any).createdAt).getTime()) / 3600000, 1);
  const engagement = likes * 1.5 + comments * 2.5 + shares * 4 + completionRate * 25;
  const viewQuality = views > 0 ? engagement / Math.sqrt(views) : engagement;
  const freshness = Math.exp(-hoursOld / 72);
  const trendingScore = Number(clamp((viewQuality * freshness) + engagement / Math.max(hoursOld, 1), 0, 1000).toFixed(2));

  await prisma.reel.update({
    where: { id: reelId },
    data: { trendingScore } as any
  });

  return trendingScore;
}

export async function clearFeedCache(userId?: string) {
  const pattern = userId ? `feed:*:${userId}:*` : 'feed:*';
  const deleted = await deleteByPattern(pattern);
  return { success: true, deleted };
}
