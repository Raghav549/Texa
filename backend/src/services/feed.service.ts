import { prisma } from "../config/db";

type AnyRecord = Record<string, any>;

type FeedItemType = "REEL" | "STORY" | "POST" | "PRODUCT" | "ROOM" | "USER" | "AD";

type FeedScoreInput = {
  id?: string;
  type?: FeedItemType | string;
  views?: number;
  viewCount?: number;
  likes?: number;
  likeCount?: number;
  comments?: number;
  commentCount?: number;
  shares?: number;
  shareCount?: number;
  saves?: number;
  saveCount?: number;
  clicks?: number;
  clickCount?: number;
  watchTime?: number;
  completionRate?: number;
  engagementRate?: number;
  reportCount?: number;
  hideCount?: number;
  flagged?: boolean;
  isVerifiedCreator?: boolean;
  creatorTrustScore?: number;
  freshnessBoost?: number;
  createdAt?: Date | string | number | null;
  updatedAt?: Date | string | number | null;
};

type FeedOptions = {
  userId?: string;
  cursor?: string | null;
  limit?: number;
  type?: FeedItemType | string;
  includeAds?: boolean;
  includeProducts?: boolean;
  includeRooms?: boolean;
  language?: string;
  country?: string;
  interests?: string[];
  excludeIds?: string[];
};

type FeedCursor = {
  score: number;
  id: string;
  createdAt: string;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 60;
const MIN_SCORE = -999999;

function toNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(value: any) {
  if (!value) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeLimit(limit?: number) {
  return clamp(Math.floor(toNumber(limit, DEFAULT_LIMIT)), 1, MAX_LIMIT);
}

function encodeCursor(cursor: FeedCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string | null): FeedCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string") return null;
    return {
      id: parsed.id,
      score: toNumber(parsed.score, MIN_SCORE),
      createdAt: String(parsed.createdAt || new Date().toISOString())
    };
  } catch {
    return null;
  }
}

function hoursSince(value: any) {
  const createdAt = toDate(value).getTime();
  return Math.max(1, (Date.now() - createdAt) / 3600000);
}

function normalizeItemType(value: any): FeedItemType {
  const type = String(value || "").toUpperCase();
  if (["REEL", "STORY", "POST", "PRODUCT", "ROOM", "USER", "AD"].includes(type)) return type as FeedItemType;
  return "POST";
}

function uniqueById<T extends AnyRecord>(items: T[]) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = String(item?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function calculateTrendingScore(input: FeedScoreInput | AnyRecord = {}) {
  const views = toNumber(input.views ?? input.viewCount);
  const likes = toNumber(input.likes ?? input.likeCount);
  const comments = toNumber(input.comments ?? input.commentCount);
  const shares = toNumber(input.shares ?? input.shareCount);
  const saves = toNumber(input.saves ?? input.saveCount);
  const clicks = toNumber(input.clicks ?? input.clickCount);
  const watchTime = toNumber(input.watchTime);
  const completionRate = clamp(toNumber(input.completionRate), 0, 1);
  const engagementRate = clamp(toNumber(input.engagementRate), 0, 1);
  const reportCount = toNumber(input.reportCount);
  const hideCount = toNumber(input.hideCount);
  const creatorTrustScore = clamp(toNumber(input.creatorTrustScore, 50), 0, 100);
  const freshnessBoost = clamp(toNumber(input.freshnessBoost), 0, 100);
  const ageHours = hoursSince(input.createdAt || input.updatedAt);
  const type = normalizeItemType(input.type);

  const viewScore = Math.log10(views + 1) * 8;
  const likeScore = likes * 2.2;
  const commentScore = comments * 3.6;
  const shareScore = shares * 6.5;
  const saveScore = saves * 5.2;
  const clickScore = clicks * 1.4;
  const watchScore = Math.log10(watchTime + 1) * 7;
  const completionScore = completionRate * 35;
  const engagementScore = engagementRate * 45;
  const trustScore = creatorTrustScore * 0.28;
  const verifiedBoost = input.isVerifiedCreator ? 8 : 0;

  const typeBoostMap: Record<FeedItemType, number> = {
    REEL: 12,
    STORY: 5,
    POST: 8,
    PRODUCT: 7,
    ROOM: 9,
    USER: 3,
    AD: -2
  };

  const penalty = reportCount * 18 + hideCount * 9 + (input.flagged ? 80 : 0);
  const raw =
    viewScore +
    likeScore +
    commentScore +
    shareScore +
    saveScore +
    clickScore +
    watchScore +
    completionScore +
    engagementScore +
    trustScore +
    verifiedBoost +
    freshnessBoost +
    typeBoostMap[type] -
    penalty;

  const decay = Math.pow(ageHours + 2, 1.12);
  const score = raw / decay;

  return Number(score.toFixed(6));
}

export function calculatePersonalizedScore(item: AnyRecord, userSignals: AnyRecord = {}) {
  const base = calculateTrendingScore(item);
  const interests = Array.isArray(userSignals.interests) ? userSignals.interests.map((x: any) => String(x).toLowerCase()) : [];
  const tags = Array.isArray(item.tags) ? item.tags.map((x: any) => String(x).toLowerCase()) : [];
  const category = String(item.category || item.niche || "").toLowerCase();
  const language = String(item.language || "").toLowerCase();
  const userLanguage = String(userSignals.language || "").toLowerCase();
  const country = String(item.country || "").toLowerCase();
  const userCountry = String(userSignals.country || "").toLowerCase();

  const tagMatches = tags.filter((tag: string) => interests.includes(tag)).length;
  const categoryMatch = category && interests.includes(category) ? 1 : 0;
  const languageBoost = language && userLanguage && language === userLanguage ? 7 : 0;
  const countryBoost = country && userCountry && country === userCountry ? 4 : 0;
  const followingBoost = Array.isArray(userSignals.followingIds) && userSignals.followingIds.includes(item.creatorId || item.userId) ? 12 : 0;
  const blockedPenalty = Array.isArray(userSignals.blockedIds) && userSignals.blockedIds.includes(item.creatorId || item.userId) ? 1000 : 0;
  const seenPenalty = Array.isArray(userSignals.seenIds) && userSignals.seenIds.includes(item.id) ? 35 : 0;

  return Number((base + tagMatches * 9 + categoryMatch * 10 + languageBoost + countryBoost + followingBoost - blockedPenalty - seenPenalty).toFixed(6));
}

export function rankFeedItems<T extends AnyRecord>(items: T[], userSignals: AnyRecord = {}) {
  return uniqueById(items)
    .map(item => ({
      ...item,
      feedScore: calculatePersonalizedScore(item, userSignals)
    }))
    .sort((a, b) => {
      const scoreDiff = toNumber(b.feedScore) - toNumber(a.feedScore);
      if (scoreDiff !== 0) return scoreDiff;
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });
}

async function getUserSignals(userId?: string) {
  if (!userId) {
    return {
      interests: [],
      followingIds: [],
      blockedIds: [],
      seenIds: []
    };
  }

  const [user, following, blocks] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        language: true,
        country: true,
        interests: true
      } as any
    }).catch(() => null),
    (prisma as any).follow?.findMany
      ? (prisma as any).follow.findMany({
          where: { followerId: userId },
          select: { followingId: true },
          take: 2000
        }).catch(() => [])
      : Promise.resolve([]),
    (prisma as any).block?.findMany
      ? (prisma as any).block.findMany({
          where: { blockerId: userId },
          select: { blockedId: true },
          take: 2000
        }).catch(() => [])
      : Promise.resolve([])
  ]);

  return {
    language: (user as any)?.language,
    country: (user as any)?.country,
    interests: Array.isArray((user as any)?.interests) ? (user as any).interests : [],
    followingIds: Array.isArray(following) ? following.map((x: any) => x.followingId).filter(Boolean) : [],
    blockedIds: Array.isArray(blocks) ? blocks.map((x: any) => x.blockedId).filter(Boolean) : [],
    seenIds: []
  };
}

async function fetchReels(options: FeedOptions) {
  if (!(prisma as any).reel?.findMany) return [];

  const excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds : [];

  const reels = await (prisma as any).reel.findMany({
    where: {
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      OR: [
        { flagged: false },
        { flagged: null }
      ]
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          isVerified: true,
          level: true
        }
      }
    },
    orderBy: [
      { createdAt: "desc" }
    ],
    take: safeLimit(options.limit) * 3
  }).catch(() => []);

  return reels.map((reel: any) => ({
    ...reel,
    type: "REEL",
    creatorId: reel.userId,
    isVerifiedCreator: !!reel.user?.isVerified,
    views: reel.views ?? reel.viewCount ?? 0,
    likes: reel.likes ?? reel.likeCount ?? 0,
    comments: reel.comments ?? reel.commentCount ?? 0,
    shares: reel.shares ?? reel.shareCount ?? 0,
    saves: reel.saves ?? reel.saveCount ?? 0
  }));
}

async function fetchStories(options: FeedOptions) {
  if (!(prisma as any).story?.findMany) return [];

  const excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds : [];

  const stories = await (prisma as any).story.findMany({
    where: {
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      OR: [
        { flagged: false },
        { flagged: null }
      ]
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          isVerified: true
        }
      }
    },
    orderBy: [
      { createdAt: "desc" }
    ],
    take: safeLimit(options.limit)
  }).catch(() => []);

  return stories.map((story: any) => ({
    ...story,
    type: "STORY",
    creatorId: story.userId,
    isVerifiedCreator: !!story.user?.isVerified
  }));
}

async function fetchProducts(options: FeedOptions) {
  if (!options.includeProducts) return [];
  if (!(prisma as any).product?.findMany) return [];

  const excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds : [];

  const products = await (prisma as any).product.findMany({
    where: {
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      OR: [
        { status: "ACTIVE" },
        { status: "active" },
        { status: "PUBLISHED" },
        { status: "published" }
      ]
    },
    include: {
      store: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          isVerified: true,
          ownerId: true,
          userId: true
        }
      }
    },
    orderBy: [
      { createdAt: "desc" }
    ],
    take: Math.ceil(safeLimit(options.limit) / 2)
  }).catch(() => []);

  return products.map((product: any) => ({
    ...product,
    type: "PRODUCT",
    creatorId: product.store?.ownerId || product.store?.userId,
    isVerifiedCreator: !!product.store?.isVerified,
    views: product.views ?? 0,
    likes: product.likes ?? 0,
    clicks: product.clicks ?? 0,
    saves: product.saves ?? 0
  }));
}

async function fetchRooms(options: FeedOptions) {
  if (!options.includeRooms) return [];
  if (!(prisma as any).voiceRoom?.findMany) return [];

  const rooms = await (prisma as any).voiceRoom.findMany({
    where: {
      OR: [
        { status: "LIVE" },
        { status: "live" },
        { status: "ACTIVE" },
        { status: "active" }
      ]
    },
    include: {
      host: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          isVerified: true
        }
      }
    },
    orderBy: [
      { updatedAt: "desc" }
    ],
    take: Math.ceil(safeLimit(options.limit) / 2)
  }).catch(() => []);

  return rooms.map((room: any) => ({
    ...room,
    type: "ROOM",
    creatorId: room.hostId || room.userId,
    isVerifiedCreator: !!room.host?.isVerified,
    views: room.listenerCount ?? room.listenersCount ?? room.participantCount ?? 0
  }));
}

function applyCursor<T extends AnyRecord>(items: T[], cursor?: string | null) {
  const decoded = decodeCursor(cursor);
  if (!decoded) return items;

  return items.filter(item => {
    const score = toNumber(item.feedScore, MIN_SCORE);
    const createdAt = toDate(item.createdAt).toISOString();
    if (score < decoded.score) return true;
    if (score === decoded.score && createdAt < decoded.createdAt) return true;
    if (score === decoded.score && createdAt === decoded.createdAt && String(item.id) > decoded.id) return true;
    return false;
  });
}

function buildNextCursor(items: AnyRecord[]) {
  const last = items[items.length - 1];
  if (!last?.id) return null;
  return encodeCursor({
    id: String(last.id),
    score: toNumber(last.feedScore, MIN_SCORE),
    createdAt: toDate(last.createdAt).toISOString()
  });
}

export async function getPersonalizedFeed(options: FeedOptions = {}) {
  const limit = safeLimit(options.limit);
  const userSignals = await getUserSignals(options.userId);

  const mergedSignals = {
    ...userSignals,
    language: options.language || (userSignals as any).language,
    country: options.country || (userSignals as any).country,
    interests: Array.isArray(options.interests) && options.interests.length ? options.interests : (userSignals as any).interests
  };

  const requestedType = options.type ? normalizeItemType(options.type) : null;

  const tasks: Promise<AnyRecord[]>[] = [];

  if (!requestedType || requestedType === "REEL") tasks.push(fetchReels({ ...options, limit }));
  if (!requestedType || requestedType === "STORY") tasks.push(fetchStories({ ...options, limit }));
  if (!requestedType || requestedType === "PRODUCT") tasks.push(fetchProducts({ ...options, limit }));
  if (!requestedType || requestedType === "ROOM") tasks.push(fetchRooms({ ...options, limit }));

  const batches = await Promise.all(tasks);
  const ranked = rankFeedItems(batches.flat(), mergedSignals);
  const paged = applyCursor(ranked, options.cursor).slice(0, limit);

  return {
    items: paged,
    nextCursor: buildNextCursor(paged),
    hasMore: paged.length === limit,
    meta: {
      limit,
      type: requestedType || "MIXED",
      generatedAt: new Date().toISOString()
    }
  };
}

export async function getTrendingFeed(options: FeedOptions = {}) {
  const limit = safeLimit(options.limit);
  const items = await Promise.all([
    fetchReels({ ...options, limit }),
    fetchStories({ ...options, limit }),
    fetchProducts({ ...options, limit, includeProducts: options.includeProducts }),
    fetchRooms({ ...options, limit, includeRooms: options.includeRooms })
  ]);

  const ranked = rankFeedItems(items.flat(), {
    language: options.language,
    country: options.country,
    interests: options.interests || []
  });

  const paged = applyCursor(ranked, options.cursor).slice(0, limit);

  return {
    items: paged,
    nextCursor: buildNextCursor(paged),
    hasMore: paged.length === limit,
    meta: {
      limit,
      generatedAt: new Date().toISOString()
    }
  };
}

export async function getCreatorFeed(creatorId: string, options: FeedOptions = {}) {
  const limit = safeLimit(options.limit);
  if (!creatorId) {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      meta: { limit, creatorId, generatedAt: new Date().toISOString() }
    };
  }

  const [reels, stories] = await Promise.all([
    (prisma as any).reel?.findMany
      ? (prisma as any).reel.findMany({
          where: { userId: creatorId },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                fullName: true,
                avatarUrl: true,
                isVerified: true
              }
            }
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit * 2
        }).catch(() => [])
      : Promise.resolve([]),
    (prisma as any).story?.findMany
      ? (prisma as any).story.findMany({
          where: { userId: creatorId },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                fullName: true,
                avatarUrl: true,
                isVerified: true
              }
            }
          },
          orderBy: [{ createdAt: "desc" }],
          take: limit
        }).catch(() => [])
      : Promise.resolve([])
  ]);

  const normalized = [
    ...reels.map((item: any) => ({
      ...item,
      type: "REEL",
      creatorId,
      isVerifiedCreator: !!item.user?.isVerified
    })),
    ...stories.map((item: any) => ({
      ...item,
      type: "STORY",
      creatorId,
      isVerifiedCreator: !!item.user?.isVerified
    }))
  ];

  const ranked = rankFeedItems(normalized);
  const paged = applyCursor(ranked, options.cursor).slice(0, limit);

  return {
    items: paged,
    nextCursor: buildNextCursor(paged),
    hasMore: paged.length === limit,
    meta: {
      limit,
      creatorId,
      generatedAt: new Date().toISOString()
    }
  };
}

export async function recordFeedImpression(userId: string | undefined | null, itemId: string, itemType: string, extra: AnyRecord = {}) {
  if (!itemId) return null;

  if ((prisma as any).feedImpression?.create) {
    return (prisma as any).feedImpression.create({
      data: {
        userId: userId || null,
        itemId,
        itemType,
        source: extra.source || "feed",
        metadata: extra.metadata || extra || {}
      }
    }).catch(() => null);
  }

  if ((prisma as any).analyticsEvent?.create) {
    return (prisma as any).analyticsEvent.create({
      data: {
        userId: userId || null,
        type: "FEED_IMPRESSION",
        entityId: itemId,
        entityType: itemType,
        metadata: extra || {}
      }
    }).catch(() => null);
  }

  return null;
}

export async function recordFeedAction(userId: string | undefined | null, itemId: string, itemType: string, action: string, extra: AnyRecord = {}) {
  if (!itemId || !action) return null;

  if ((prisma as any).feedAction?.create) {
    return (prisma as any).feedAction.create({
      data: {
        userId: userId || null,
        itemId,
        itemType,
        action,
        metadata: extra || {}
      }
    }).catch(() => null);
  }

  if ((prisma as any).analyticsEvent?.create) {
    return (prisma as any).analyticsEvent.create({
      data: {
        userId: userId || null,
        type: `FEED_${String(action).toUpperCase()}`,
        entityId: itemId,
        entityType: itemType,
        metadata: extra || {}
      }
    }).catch(() => null);
  }

  return null;
}

export async function refreshFeedScore(model: string, id: string) {
  if (!model || !id) return null;

  const client = (prisma as any)[model];
  if (!client?.findUnique || !client?.update) return null;

  const item = await client.findUnique({ where: { id } }).catch(() => null);
  if (!item) return null;

  const score = calculateTrendingScore(item);

  return client.update({
    where: { id },
    data: { trendingScore: score }
  }).catch(() => item);
}

export const feedService = {
  calculateTrendingScore,
  calculatePersonalizedScore,
  rankFeedItems,
  getPersonalizedFeed,
  getTrendingFeed,
  getCreatorFeed,
  recordFeedImpression,
  recordFeedAction,
  refreshFeedScore
};

export default feedService;
