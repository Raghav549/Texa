import { Server, Socket, Namespace } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';
import { calculateTrendingScore } from '../services/feed.service';

type ReelSocketAuth = {
  userId?: string;
  id?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

type WatchPayload = {
  reelId?: string;
  position?: number;
  duration?: number;
  completed?: boolean;
  muted?: boolean;
  loopCount?: number;
  sessionId?: string;
};

type EngagePayload = {
  reelId?: string;
  action?: 'like' | 'unlike' | 'comment' | 'share' | 'save' | 'unsave' | 'tip' | 'follow';
  value?: any;
};

type Ack<T = any> = (response: T) => void;

type ReelAccessResult =
  | {
      ok: true;
      reel: any;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

const activeViewers = new Map<string, Set<string>>();
const watchBuffer = new Map<string, WatchPayload & { userId: string; updatedAt: number }>();
const watchFlushTimers = new Map<string, NodeJS.Timeout>();
const reelPresenceTimers = new Map<string, NodeJS.Timeout>();
const trendingIntervals = new WeakMap<Server, NodeJS.Timeout>();
const socketBuckets = new Map<string, { count: number; resetAt: number }>();

const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 140;
const WATCH_FLUSH_DELAY = 4000;
const PRESENCE_TTL = 15_000;
const TRENDING_INTERVAL = 5 * 60 * 1000;
const MAX_POSITION_SECONDS = 24 * 60 * 60;
const DEFAULT_REEL_DURATION = 30;

const normalizeString = (value: unknown) => String(value || '').trim();

const normalizeNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const roomForUser = (userId: string) => `user:${userId}`;

const roomForReel = (reelId: string) => `reel:${reelId}`;

const roomForTrending = (region: string) => `trending:${normalizeString(region) || 'global'}`;

const roomForCreator = (creatorId: string) => `creator:${creatorId}`;

const safeAck = (ack: unknown, payload: any) => {
  if (typeof ack === 'function') {
    try {
      (ack as Ack)(payload);
    } catch {}
  }
};

const isValidId = (value: any) => typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);

const getJWTSecret = () => {
  const secret = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw new Error('JWT secret missing');
  return secret;
};

const getToken = (socket: Socket) => {
  const authToken = socket.handshake.auth?.token;
  const headerToken = socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, '');
  const queryToken = socket.handshake.query?.token;

  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return '';
};

const emitSocketError = (socket: Socket, code: string, message: string, meta?: any) => {
  socket.emit('reel:error', {
    code,
    message,
    meta: meta || null,
    timestamp: new Date().toISOString()
  });
};

const rateLimit = (socket: Socket) => {
  const now = Date.now();
  const bucket = socketBuckets.get(socket.id);

  if (!bucket || bucket.resetAt <= now) {
    socketBuckets.set(socket.id, {
      count: 1,
      resetAt: now + SOCKET_RATE_LIMIT_WINDOW
    });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= SOCKET_RATE_LIMIT_MAX;
};

const bindRateLimit = (socket: Socket) => {
  socket.use((packet, next) => {
    if (!rateLimit(socket)) {
      emitSocketError(socket, 'RATE_LIMITED', 'Too many socket events');
      return;
    }

    next();
  });
};

const getActiveUser = async (userId: string, fallbackRole?: string | null) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      following: true,
      isBanned: true
    } as any
  }).catch(() => null);

  if (!user || (user as any).isBanned) return null;

  return {
    id: user.id,
    role: String((user as any).role || fallbackRole || 'USER'),
    following: Array.isArray((user as any).following) ? (user as any).following : []
  };
};

const getReelSelect = () => ({
  id: true,
  userId: true,
  visibility: true,
  duration: true,
  views: true,
  uniqueViews: true,
  watchTime: true,
  likes: true,
  shares: true,
  saves: true,
  completionRate: true,
  avgWatchPercent: true,
  engagementRate: true,
  viralCoefficient: true,
  trendingScore: true,
  moderationStatus: true,
  publishedAt: true,
  createdAt: true,
  isDraft: true,
  category: true,
  language: true,
  region: true
});

const verifyReelAccess = async (reelId: string, userId: string): Promise<ReelAccessResult> => {
  if (!isValidId(reelId) || !isValidId(userId)) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid reel'
    };
  }

  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: getReelSelect() as any
  }).catch(() => null);

  if (!reel) {
    return {
      ok: false,
      status: 404,
      error: 'Reel not found'
    };
  }

  if ((reel as any).isDraft && (reel as any).userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: 'Draft reel'
    };
  }

  const moderationStatus = normalizeString((reel as any).moderationStatus).toLowerCase();

  if (moderationStatus && !['approved', 'pending'].includes(moderationStatus) && (reel as any).userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: 'Reel unavailable'
    };
  }

  const visibility = normalizeString((reel as any).visibility).toLowerCase();

  if (visibility === 'private' && (reel as any).userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: 'Private reel'
    };
  }

  if (visibility === 'followers' && (reel as any).userId !== userId) {
    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    }).catch(() => null);

    if (!Array.isArray((viewer as any)?.following) || !(viewer as any).following.includes((reel as any).userId)) {
      return {
        ok: false,
        status: 403,
        error: 'Followers only'
      };
    }
  }

  return {
    ok: true,
    reel
  };
};

const getLikeCount = (reel: any) => Array.isArray(reel?.likes) ? reel.likes.length : normalizeNumber(reel?.likes, 0);

const getSaveCount = (reel: any) => Array.isArray(reel?.saves) ? reel.saves.length : normalizeNumber(reel?.saves, 0);

const getEngagementCounts = async (reelId: string) => {
  const [reel, comments, saves] = await Promise.all([
    prisma.reel.findUnique({
      where: { id: reelId },
      select: {
        likes: true,
        shares: true,
        saves: true,
        views: true,
        uniqueViews: true,
        watchTime: true,
        completionRate: true,
        avgWatchPercent: true,
        engagementRate: true,
        viralCoefficient: true,
        trendingScore: true
      } as any
    }).catch(() => null),
    prisma.comment.count({
      where: {
        reelId,
        moderationStatus: 'approved'
      } as any
    }).catch(() => 0),
    prisma.reelSave.count({
      where: { reelId }
    }).catch(() => null)
  ]);

  return {
    likes: getLikeCount(reel),
    comments,
    shares: normalizeNumber((reel as any)?.shares, 0),
    saves: typeof saves === 'number' ? saves : getSaveCount(reel),
    views: normalizeNumber((reel as any)?.views, 0),
    uniqueViews: normalizeNumber((reel as any)?.uniqueViews, 0),
    watchTime: normalizeNumber((reel as any)?.watchTime, 0),
    completionRate: clamp(normalizeNumber((reel as any)?.completionRate, 0), 0, 1),
    avgWatchPercent: clamp(normalizeNumber((reel as any)?.avgWatchPercent, 0), 0, 1),
    engagementRate: clamp(normalizeNumber((reel as any)?.engagementRate, 0), 0, 100),
    viralCoefficient: clamp(normalizeNumber((reel as any)?.viralCoefficient, 0), 0, 100),
    trendingScore: normalizeNumber((reel as any)?.trendingScore, 0)
  };
};

const updateReelDerivedMetrics = async (tx: any, reelId: string) => {
  const reel = await tx.reel.findUnique({
    where: { id: reelId },
    select: {
      id: true,
      views: true,
      uniqueViews: true,
      likes: true,
      shares: true,
      saves: true,
      watchTime: true,
      completionRate: true,
      avgWatchPercent: true,
      engagementRate: true,
      viralCoefficient: true,
      trendingScore: true,
      publishedAt: true,
      createdAt: true
    } as any
  });

  if (!reel) return null;

  const commentCount = await tx.comment.count({
    where: {
      reelId,
      moderationStatus: 'approved'
    } as any
  }).catch(() => 0);

  const saveCount = await tx.reelSave.count({
    where: { reelId }
  }).catch(() => getSaveCount(reel));

  const views = Math.max(normalizeNumber(reel.views, 0), 1);
  const likes = getLikeCount(reel);
  const shares = normalizeNumber(reel.shares, 0);
  const saves = normalizeNumber(saveCount, 0);
  const engagementRate = clamp((likes + commentCount * 1.5 + shares * 2 + saves * 1.7) / views, 0, 100);
  const viralCoefficient = clamp((shares * 2.5 + saves * 1.4 + commentCount * 1.2 + likes * 0.6) / views, 0, 100);
  const trendingScore = calculateTrendingScore({
    ...reel,
    _count: {
      comments: commentCount,
      saves,
      shares,
      likes
    }
  } as any);

  await tx.reel.update({
    where: { id: reelId },
    data: {
      engagementRate,
      viralCoefficient,
      trendingScore
    } as any
  });

  return {
    engagementRate,
    viralCoefficient,
    trendingScore
  };
};

const emitEngagementSnapshot = async (ns: Namespace, reelId: string, extra: Record<string, any> = {}) => {
  const counts = await getEngagementCounts(reelId);

  ns.to(roomForReel(reelId)).emit('reel:engagement_update', {
    reelId,
    counts,
    ...extra,
    timestamp: new Date().toISOString()
  });

  return counts;
};

const flushWatchProgress = async (io: Server, key: string) => {
  const payload = watchBuffer.get(key);
  if (!payload) return;

  watchBuffer.delete(key);

  const reelId = normalizeString(payload.reelId);
  const userId = normalizeString(payload.userId);

  if (!isValidId(reelId) || !isValidId(userId)) return;

  const access = await verifyReelAccess(reelId, userId);
  if (!access.ok) return;

  const duration = clamp(Math.max(1, normalizeNumber(payload.duration, access.reel.duration || DEFAULT_REEL_DURATION)), 1, MAX_POSITION_SECONDS);
  const position = clamp(normalizeNumber(payload.position, 0), 0, duration);
  const completed = Boolean(payload.completed) || position / duration >= 0.95;
  const progress = completed ? 1 : clamp(position / duration, 0, 1);
  const now = new Date();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const recentView = await prisma.viewHistory.findFirst({
    where: {
      reelId,
      userId,
      watchedAt: {
        gt: oneHourAgo
      }
    } as any,
    orderBy: {
      watchedAt: 'desc'
    } as any
  }).catch(() => null);

  await prisma.$transaction(async tx => {
    await tx.watchProgress.upsert({
      where: {
        reelId_userId: {
          reelId,
          userId
        }
      },
      update: {
        lastPosition: position,
        progress,
        updatedAt: now
      },
      create: {
        reelId,
        userId,
        lastPosition: position,
        progress
      }
    });

    if (!recentView && progress >= 0.08) {
      await tx.viewHistory.create({
        data: {
          reelId,
          userId,
          watchDuration: position,
          completed,
          watchedAt: now,
          deviceInfo: {
            sessionId: payload.sessionId || null,
            muted: Boolean(payload.muted),
            loopCount: normalizeNumber(payload.loopCount, 0)
          }
        } as any
      });

      await tx.reel.update({
        where: {
          id: reelId
        },
        data: {
          views: {
            increment: 1
          },
          uniqueViews: {
            increment: 1
          },
          watchTime: {
            increment: position
          }
        } as any
      });
    }

    if (recentView) {
      const previousDuration = normalizeNumber((recentView as any).watchDuration, 0);
      const increment = Math.max(0, position - previousDuration);

      await tx.viewHistory.update({
        where: {
          id: (recentView as any).id
        },
        data: {
          watchDuration: Math.max(previousDuration, position),
          completed: Boolean((recentView as any).completed) || completed,
          watchedAt: now,
          deviceInfo: {
            ...(typeof (recentView as any).deviceInfo === 'object' && (recentView as any).deviceInfo ? (recentView as any).deviceInfo : {}),
            sessionId: payload.sessionId || null,
            muted: Boolean(payload.muted),
            loopCount: normalizeNumber(payload.loopCount, 0)
          }
        } as any
      });

      if (increment > 0) {
        await tx.reel.update({
          where: {
            id: reelId
          },
          data: {
            watchTime: {
              increment
            }
          } as any
        });
      }
    }

    const aggregate = await tx.viewHistory.aggregate({
      where: {
        reelId
      },
      _count: true,
      _avg: {
        watchDuration: true
      }
    }).catch(() => null);

    const completedCount = await tx.viewHistory.count({
      where: {
        reelId,
        completed: true
      }
    }).catch(() => 0);

    const totalViews = Math.max(normalizeNumber((aggregate as any)?._count, 0), 1);
    const avgWatchDuration = normalizeNumber((aggregate as any)?._avg?.watchDuration, 0);
    const completionRate = clamp(completedCount / totalViews, 0, 1);
    const avgWatchPercent = clamp(avgWatchDuration / duration, 0, 1);

    await tx.reel.update({
      where: {
        id: reelId
      },
      data: {
        completionRate,
        avgWatchPercent
      } as any
    });

    await updateReelDerivedMetrics(tx, reelId);
  });

  const ns = io.of('/reels');
  const counts = await getEngagementCounts(reelId);

  ns.to(roomForReel(reelId)).emit('reel:watch_update', {
    reelId,
    userId,
    progress,
    position,
    duration,
    completed,
    counts,
    timestamp: now.toISOString()
  });
};

const queueWatchProgress = (io: Server, payload: WatchPayload & { userId: string }) => {
  const reelId = normalizeString(payload.reelId);
  const userId = normalizeString(payload.userId);
  const sessionId = normalizeString(payload.sessionId) || 'default';

  if (!isValidId(reelId) || !isValidId(userId)) return;

  const key = `${reelId}:${userId}:${sessionId}`;
  const previous = watchBuffer.get(key);

  watchBuffer.set(key, {
    ...previous,
    ...payload,
    reelId,
    userId,
    sessionId,
    position: Math.max(normalizeNumber(previous?.position, 0), normalizeNumber(payload.position, 0)),
    completed: Boolean(previous?.completed) || Boolean(payload.completed),
    updatedAt: Date.now()
  });

  if (payload.completed) {
    const timer = watchFlushTimers.get(key);
    if (timer) clearTimeout(timer);
    watchFlushTimers.delete(key);
    flushWatchProgress(io, key).catch(() => null);
    return;
  }

  if (watchFlushTimers.has(key)) return;

  const timer = setTimeout(() => {
    watchFlushTimers.delete(key);
    flushWatchProgress(io, key).catch(() => null);
  }, WATCH_FLUSH_DELAY);

  watchFlushTimers.set(key, timer);
};

const updateActiveViewer = (io: Server, reelId: string, userId: string, active: boolean) => {
  if (!isValidId(reelId) || !isValidId(userId)) return;

  const viewers = activeViewers.get(reelId) || new Set<string>();

  if (active) viewers.add(userId);
  else viewers.delete(userId);

  if (viewers.size) activeViewers.set(reelId, viewers);
  else activeViewers.delete(reelId);

  io.of('/reels').to(roomForReel(reelId)).emit('reel:active_viewers', {
    reelId,
    count: viewers.size,
    timestamp: new Date().toISOString()
  });
};

const schedulePresenceExpiry = (io: Server, reelId: string, userId: string) => {
  const key = `${reelId}:${userId}`;
  const oldTimer = reelPresenceTimers.get(key);

  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    reelPresenceTimers.delete(key);
    updateActiveViewer(io, reelId, userId, false);
  }, PRESENCE_TTL);

  reelPresenceTimers.set(key, timer);
};

const clearPresence = (io: Server, reelId: string, userId: string) => {
  const key = `${reelId}:${userId}`;
  const timer = reelPresenceTimers.get(key);

  if (timer) clearTimeout(timer);

  reelPresenceTimers.delete(key);
  updateActiveViewer(io, reelId, userId, false);
};

const broadcastTrending = async (io: Server) => {
  const trending = await prisma.reel.findMany({
    where: {
      visibility: 'public',
      moderationStatus: 'approved',
      isDraft: false,
      publishedAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        lte: new Date()
      },
      trendingScore: {
        gt: 0
      }
    } as any,
    include: {
      author: {
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          isVerified: true
        }
      },
      music: true,
      _count: {
        select: {
          comments: true
        } as any
      }
    } as any,
    orderBy: [
      {
        trendingScore: 'desc'
      },
      {
        publishedAt: 'desc'
      }
    ] as any,
    take: 20
  }).catch(() => []);

  io.of('/reels').to(roomForTrending('global')).emit('trending:update', {
    region: 'global',
    reels: trending,
    timestamp: new Date().toISOString()
  });
};

const handleLike = async (ns: Namespace, reel: any, reelId: string, userId: string) => {
  const likes = Array.isArray(reel.likes) ? reel.likes : [];

  if (!likes.includes(userId)) {
    await prisma.reel.update({
      where: { id: reelId },
      data: {
        likes: {
          push: userId
        }
      } as any
    });

    if (reel.userId !== userId) {
      ns.to(roomForUser(reel.userId)).emit('notification:like', {
        type: 'reel_like',
        from: userId,
        reelId,
        timestamp: new Date().toISOString()
      });
    }
  }
};

const handleUnlike = async (reel: any, reelId: string, userId: string) => {
  const likes = Array.isArray(reel.likes) ? reel.likes : [];

  await prisma.reel.update({
    where: { id: reelId },
    data: {
      likes: {
        set: likes.filter((id: string) => id !== userId)
      }
    } as any
  });
};

const handleShare = async (reelId: string, userId: string, value: any) => {
  await prisma.$transaction(async tx => {
    await tx.reelShare.create({
      data: {
        reelId,
        userId,
        platform: normalizeString(value?.platform) || 'socket'
      } as any
    }).catch(() => null);

    await tx.reel.update({
      where: {
        id: reelId
      },
      data: {
        shares: {
          increment: 1
        }
      } as any
    });

    await updateReelDerivedMetrics(tx, reelId);
  });
};

const handleSave = async (reelId: string, userId: string, value: any) => {
  await prisma.$transaction(async tx => {
    await tx.reelSave.upsert({
      where: {
        reelId_userId: {
          reelId,
          userId
        }
      },
      update: {
        collectionId: value?.collectionId || null
      } as any,
      create: {
        reelId,
        userId,
        collectionId: value?.collectionId || null
      } as any
    });

    await updateReelDerivedMetrics(tx, reelId);
  });
};

const handleUnsave = async (reelId: string, userId: string) => {
  await prisma.$transaction(async tx => {
    await tx.reelSave.deleteMany({
      where: {
        reelId,
        userId
      }
    });

    await updateReelDerivedMetrics(tx, reelId);
  });
};

const handleFollow = async (creatorId: string, userId: string) => {
  if (!isValidId(creatorId) || creatorId === userId) return;

  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: { following: true }
  }).catch(() => null);

  const creator = await prisma.user.findUnique({
    where: { id: creatorId },
    select: { followers: true }
  }).catch(() => null);

  const following = Array.isArray((viewer as any)?.following) ? (viewer as any).following : [];
  const followers = Array.isArray((creator as any)?.followers) ? (creator as any).followers : [];

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        following: {
          set: following.includes(creatorId) ? following : [...following, creatorId]
        }
      } as any
    }),
    prisma.user.update({
      where: { id: creatorId },
      data: {
        followers: {
          set: followers.includes(userId) ? followers : [...followers, userId]
        }
      } as any
    })
  ]);
};

export function initReelSockets(io: Server) {
  const ns = io.of('/reels');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, getJWTSecret()) as ReelSocketAuth;
      const userId = decoded?.userId || decoded?.id;

      if (!userId || !isValidId(userId)) {
        return next(new Error('Authentication required'));
      }

      const user = await getActiveUser(userId, decoded.role);

      if (!user) {
        return next(new Error('User blocked or not found'));
      }

      socket.data.userId = user.id;
      socket.data.role = user.role;

      return next();
    } catch {
      return next(new Error('Authentication required'));
    }
  });

  ns.on('connection', (socket: Socket) => {
    const userId = normalizeString(socket.data.userId);
    const joinedReels = new Set<string>();

    bindRateLimit(socket);

    socket.join(roomForUser(userId));

    socket.emit('reel:connected', {
      userId,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });

    socket.on('reel:join', async (payload: any = {}, ack?: Ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);

        if (!isValidId(reelId)) {
          safeAck(ack, {
            success: false,
            error: 'Invalid reel id'
          });
          return emitSocketError(socket, 'INVALID_REEL_ID', 'Invalid reel id');
        }

        const access = await verifyReelAccess(reelId, userId);

        if (!access.ok) {
          safeAck(ack, {
            success: false,
            error: access.error,
            status: access.status
          });
          return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
        }

        socket.join(roomForReel(reelId));
        joinedReels.add(reelId);

        updateActiveViewer(io, reelId, userId, true);
        schedulePresenceExpiry(io, reelId, userId);

        const [counts, progress] = await Promise.all([
          getEngagementCounts(reelId),
          prisma.watchProgress.findUnique({
            where: {
              reelId_userId: {
                reelId,
                userId
              }
            },
            select: {
              progress: true,
              lastPosition: true,
              updatedAt: true
            }
          }).catch(() => null)
        ]);

        const response = {
          success: true,
          reelId,
          counts,
          progress: progress || null,
          activeViewers: activeViewers.get(reelId)?.size || 0,
          timestamp: new Date().toISOString()
        };

        socket.emit('reel:joined', response);
        safeAck(ack, response);
      } catch (error: any) {
        safeAck(ack, {
          success: false,
          error: error?.message || 'Failed to join reel'
        });
        emitSocketError(socket, 'JOIN_FAILED', 'Failed to join reel');
      }
    });

    socket.on('reel:leave', (payload: any = {}, ack?: Ack) => {
      const reelId = normalizeString(payload?.reelId);

      if (!isValidId(reelId)) {
        return safeAck(ack, {
          success: false,
          error: 'Invalid reel id'
        });
      }

      socket.leave(roomForReel(reelId));
      joinedReels.delete(reelId);
      clearPresence(io, reelId, userId);

      safeAck(ack, {
        success: true,
        reelId
      });
    });

    socket.on('reel:heartbeat', (payload: any = {}, ack?: Ack) => {
      const reelId = normalizeString(payload?.reelId);

      if (!isValidId(reelId) || !joinedReels.has(reelId)) {
        return safeAck(ack, {
          success: false,
          error: 'Not joined'
        });
      }

      updateActiveViewer(io, reelId, userId, true);
      schedulePresenceExpiry(io, reelId, userId);

      safeAck(ack, {
        success: true,
        reelId,
        activeViewers: activeViewers.get(reelId)?.size || 0
      });
    });

    socket.on('reel:watching', async (payload: WatchPayload = {}, ack?: Ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);

        if (!isValidId(reelId)) {
          safeAck(ack, {
            success: false,
            error: 'Invalid reel id'
          });
          return emitSocketError(socket, 'INVALID_REEL_ID', 'Invalid reel id');
        }

        if (!joinedReels.has(reelId)) {
          const access = await verifyReelAccess(reelId, userId);

          if (!access.ok) {
            safeAck(ack, {
              success: false,
              error: access.error
            });
            return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
          }

          socket.join(roomForReel(reelId));
          joinedReels.add(reelId);
        }

        updateActiveViewer(io, reelId, userId, true);
        schedulePresenceExpiry(io, reelId, userId);
        queueWatchProgress(io, {
          ...payload,
          reelId,
          userId
        });

        safeAck(ack, {
          success: true,
          queued: true,
          reelId
        });
      } catch (error: any) {
        safeAck(ack, {
          success: false,
          error: error?.message || 'Watch update failed'
        });
        emitSocketError(socket, 'WATCH_UPDATE_FAILED', 'Watch update failed');
      }
    });

    socket.on('reel:engage', async (payload: EngagePayload = {}, ack?: Ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);
        const action = payload?.action;

        if (!isValidId(reelId) || !action) {
          safeAck(ack, {
            success: false,
            error: 'Invalid engagement payload'
          });
          return emitSocketError(socket, 'INVALID_ENGAGEMENT', 'Invalid engagement payload');
        }

        const access = await verifyReelAccess(reelId, userId);

        if (!access.ok) {
          safeAck(ack, {
            success: false,
            error: access.error
          });
          return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
        }

        const reel = access.reel;

        if (action === 'like') {
          await handleLike(ns, reel, reelId, userId);
          await prisma.$transaction(async tx => {
            await updateReelDerivedMetrics(tx, reelId);
          });
        }

        if (action === 'unlike') {
          await handleUnlike(reel, reelId, userId);
          await prisma.$transaction(async tx => {
            await updateReelDerivedMetrics(tx, reelId);
          });
        }

        if (action === 'share') {
          await handleShare(reelId, userId, payload.value);
        }

        if (action === 'save') {
          await handleSave(reelId, userId, payload.value);
        }

        if (action === 'unsave') {
          await handleUnsave(reelId, userId);
        }

        if (action === 'follow') {
          await handleFollow(reel.userId, userId);
          ns.to(roomForCreator(reel.userId)).emit('creator:followed', {
            creatorId: reel.userId,
            userId,
            timestamp: new Date().toISOString()
          });
        }

        const counts = await emitEngagementSnapshot(ns, reelId, {
          action,
          userId
        });

        safeAck(ack, {
          success: true,
          reelId,
          action,
          counts
        });
      } catch (error: any) {
        safeAck(ack, {
          success: false,
          error: error?.message || 'Engagement failed'
        });
        emitSocketError(socket, 'ENGAGEMENT_FAILED', 'Engagement failed');
      }
    });

    socket.on('reel:request_stats', async (payload: any = {}, ack?: Ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);

        if (!isValidId(reelId)) {
          return safeAck(ack, {
            success: false,
            error: 'Invalid reel id'
          });
        }

        const access = await verifyReelAccess(reelId, userId);

        if (!access.ok) {
          return safeAck(ack, {
            success: false,
            error: access.error
          });
        }

        const [counts, progress] = await Promise.all([
          getEngagementCounts(reelId),
          prisma.watchProgress.findUnique({
            where: {
              reelId_userId: {
                reelId,
                userId
              }
            },
            select: {
              progress: true,
              lastPosition: true,
              updatedAt: true
            }
          }).catch(() => null)
        ]);

        const response = {
          success: true,
          reelId,
          counts,
          progress: progress || null,
          activeViewers: activeViewers.get(reelId)?.size || 0,
          timestamp: new Date().toISOString()
        };

        socket.emit('reel:stats', response);
        safeAck(ack, response);
      } catch (error: any) {
        safeAck(ack, {
          success: false,
          error: error?.message || 'Stats failed'
        });
      }
    });

    socket.on('reel:request_views', async (payload: any = {}, ack?: Ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);

        if (!isValidId(reelId)) {
          return safeAck(ack, {
            success: false,
            error: 'Invalid reel id'
          });
        }

        const counts = await getEngagementCounts(reelId);

        const response = {
          success: true,
          reelId,
          views: counts.views,
          uniqueViews: counts.uniqueViews,
          watchTime: counts.watchTime,
          completionRate: counts.completionRate,
          avgWatchPercent: counts.avgWatchPercent,
          timestamp: new Date().toISOString()
        };

        socket.emit('reel:view_count', response);
        safeAck(ack, response);
      } catch {
        safeAck(ack, {
          success: false,
          error: 'Failed to load views'
        });
      }
    });

    socket.on('comment:typing:start', async (payload: any = {}, ack?: Ack) => {
      const reelId = normalizeString(payload?.reelId);

      if (!isValidId(reelId)) {
        return safeAck(ack, {
          success: false,
          error: 'Invalid reel id'
        });
      }

      const access = await verifyReelAccess(reelId, userId);

      if (!access.ok) {
        return safeAck(ack, {
          success: false,
          error: access.error
        });
      }

      const user = await prisma.user.findUnique({
        where: {
          id: userId
        },
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          isVerified: true
        }
      }).catch(() => null);

      ns.to(roomForReel(reelId)).except(socket.id).emit('comment:typing', {
        reelId,
        userId,
        user,
        isTyping: true,
        timestamp: new Date().toISOString()
      });

      safeAck(ack, {
        success: true
      });
    });

    socket.on('comment:typing:stop', (payload: any = {}, ack?: Ack) => {
      const reelId = normalizeString(payload?.reelId);

      if (!isValidId(reelId)) {
        return safeAck(ack, {
          success: false,
          error: 'Invalid reel id'
        });
      }

      ns.to(roomForReel(reelId)).except(socket.id).emit('comment:typing', {
        reelId,
        userId,
        isTyping: false,
        timestamp: new Date().toISOString()
      });

      safeAck(ack, {
        success: true
      });
    });

    socket.on('trending:subscribe', (payload: any = {}, ack?: Ack) => {
      const region = normalizeString(payload?.region) || 'global';

      socket.join(roomForTrending(region));

      safeAck(ack, {
        success: true,
        region
      });

      broadcastTrending(io).catch(() => null);
    });

    socket.on('trending:unsubscribe', (payload: any = {}, ack?: Ack) => {
      const region = normalizeString(payload?.region) || 'global';

      socket.leave(roomForTrending(region));

      safeAck(ack, {
        success: true,
        region
      });
    });

    socket.on('creator:subscribe', (payload: any = {}, ack?: Ack) => {
      const creatorId = normalizeString(payload?.creatorId);

      if (!isValidId(creatorId)) {
        return safeAck(ack, {
          success: false,
          error: 'Invalid creator id'
        });
      }

      socket.join(roomForCreator(creatorId));

      safeAck(ack, {
        success: true,
        creatorId
      });
    });

    socket.on('creator:unsubscribe', (payload: any = {}, ack?: Ack) => {
      const creatorId = normalizeString(payload?.creatorId);

      if (!isValidId(creatorId)) {
        return safeAck(ack, {
          success: false,
          error: 'Invalid creator id'
        });
      }

      socket.leave(roomForCreator(creatorId));

      safeAck(ack, {
        success: true,
        creatorId
      });
    });

    socket.on('disconnect', () => {
      socketBuckets.delete(socket.id);

      for (const reelId of joinedReels) {
        clearPresence(io, reelId, userId);
      }

      for (const [key, payload] of watchBuffer.entries()) {
        if (payload.userId === userId) {
          const timer = watchFlushTimers.get(key);

          if (timer) clearTimeout(timer);

          watchFlushTimers.delete(key);
          flushWatchProgress(io, key).catch(() => null);
        }
      }

      joinedReels.clear();
    });
  });

  if (!trendingIntervals.has(io)) {
    const interval = setInterval(() => {
      broadcastTrending(io).catch(() => null);
    }, TRENDING_INTERVAL);

    trendingIntervals.set(io, interval);
  }

  return ns;
}

export function emitReelCreated(io: Server, reel: any) {
  const ns = io.of('/reels');

  if (reel?.userId) {
    ns.to(roomForCreator(reel.userId)).emit('reel:created', {
      reel,
      timestamp: new Date().toISOString()
    });
  }

  ns.to(roomForTrending(reel?.region || 'global')).emit('reel:new', {
    reel,
    timestamp: new Date().toISOString()
  });
}

export function emitReelUpdated(io: Server, reel: any) {
  if (!reel?.id) return;

  const ns = io.of('/reels');

  ns.to(roomForReel(reel.id)).emit('reel:updated', {
    reel,
    timestamp: new Date().toISOString()
  });

  if (reel.userId) {
    ns.to(roomForCreator(reel.userId)).emit('creator:reel_updated', {
      reel,
      timestamp: new Date().toISOString()
    });
  }
}

export function emitReelDeleted(io: Server, reelId: string, creatorId?: string) {
  if (!isValidId(reelId)) return;

  const ns = io.of('/reels');

  ns.to(roomForReel(reelId)).emit('reel:deleted', {
    reelId,
    timestamp: new Date().toISOString()
  });

  if (creatorId && isValidId(creatorId)) {
    ns.to(roomForCreator(creatorId)).emit('creator:reel_deleted', {
      reelId,
      creatorId,
      timestamp: new Date().toISOString()
    });
  }
}

export function emitReelCommentCreated(io: Server, reelId: string, comment: any) {
  if (!isValidId(reelId)) return;

  io.of('/reels').to(roomForReel(reelId)).emit('comment:created', {
    reelId,
    comment,
    timestamp: new Date().toISOString()
  });
}

export function emitReelCommentDeleted(io: Server, reelId: string, commentId: string) {
  if (!isValidId(reelId) || !isValidId(commentId)) return;

  io.of('/reels').to(roomForReel(reelId)).emit('comment:deleted', {
    reelId,
    commentId,
    timestamp: new Date().toISOString()
  });
}

export function getReelRoom(reelId: string) {
  return roomForReel(reelId);
}

export function getCreatorRoom(creatorId: string) {
  return roomForCreator(creatorId);
}

export function getReelActiveViewerCount(reelId: string) {
  return activeViewers.get(reelId)?.size || 0;
}
