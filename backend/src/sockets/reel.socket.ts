import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';

type ReelSocketAuth = {
  userId: string;
  role?: string;
};

type WatchPayload = {
  reelId: string;
  position?: number;
  duration?: number;
  completed?: boolean;
  muted?: boolean;
  loopCount?: number;
  sessionId?: string;
};

type EngagePayload = {
  reelId: string;
  action: 'like' | 'unlike' | 'comment' | 'share' | 'save' | 'unsave' | 'tip' | 'follow';
  value?: any;
};

const activeViewers = new Map<string, Set<string>>();
const watchBuffer = new Map<string, WatchPayload & { userId: string; updatedAt: number }>();
const watchFlushTimers = new Map<string, NodeJS.Timeout>();
const reelPresenceTimers = new Map<string, NodeJS.Timeout>();
const trendingIntervals = new WeakMap<Server, NodeJS.Timeout>();

const normalizeString = (value: unknown) => String(value || '').trim();

const normalizeNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const roomForUser = (userId: string) => `user:${userId}`;

const roomForReel = (reelId: string) => `reel:${reelId}`;

const roomForTrending = (region: string) => `trending:${region || 'global'}`;

const safeAck = (ack: unknown, payload: any) => {
  if (typeof ack === 'function') {
    try {
      ack(payload);
    } catch {}
  }
};

const emitSocketError = (socket: Socket, code: string, message: string, meta?: any) => {
  socket.emit('reel:error', { code, message, meta: meta || null, timestamp: new Date().toISOString() });
};

const verifyReelAccess = async (reelId: string, userId: string) => {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: {
      id: true,
      userId: true,
      visibility: true,
      duration: true,
      views: true,
      likes: true,
      shares: true,
      saves: true,
      completionRate: true,
      moderationStatus: true,
      publishedAt: true,
      isDraft: true
    }
  });

  if (!reel) return { ok: false as const, status: 404, error: 'Reel not found' };
  if (reel.isDraft && reel.userId !== userId) return { ok: false as const, status: 403, error: 'Draft reel' };
  if (reel.moderationStatus && !['approved', 'pending'].includes(reel.moderationStatus) && reel.userId !== userId) return { ok: false as const, status: 403, error: 'Reel unavailable' };
  if (reel.visibility === 'private' && reel.userId !== userId) return { ok: false as const, status: 403, error: 'Private reel' };

  if (reel.visibility === 'followers' && reel.userId !== userId) {
    const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { following: true } });
    if (!viewer?.following?.includes(reel.userId)) return { ok: false as const, status: 403, error: 'Followers only' };
  }

  return { ok: true as const, reel };
};

const getEngagementCounts = async (reelId: string) => {
  const [reel, comments] = await Promise.all([
    prisma.reel.findUnique({
      where: { id: reelId },
      select: { likes: true, shares: true, saves: true, views: true, uniqueViews: true, watchTime: true, completionRate: true }
    }),
    prisma.comment.count({ where: { reelId, moderationStatus: 'approved' } }).catch(() => 0)
  ]);

  return {
    likes: reel?.likes?.length || 0,
    comments,
    shares: reel?.shares || 0,
    saves: Array.isArray((reel as any)?.saves) ? (reel as any).saves.length : Number((reel as any)?.saves || 0),
    views: reel?.views || 0,
    uniqueViews: reel?.uniqueViews || 0,
    watchTime: reel?.watchTime || 0,
    completionRate: reel?.completionRate || 0
  };
};

const flushWatchProgress = async (io: Server, key: string) => {
  const payload = watchBuffer.get(key);
  if (!payload) return;

  watchBuffer.delete(key);

  const reelId = normalizeString(payload.reelId);
  const userId = normalizeString(payload.userId);
  if (!reelId || !userId) return;

  const access = await verifyReelAccess(reelId, userId);
  if (!access.ok) return;

  const duration = Math.max(1, normalizeNumber(payload.duration, access.reel.duration || 30));
  const position = clamp(normalizeNumber(payload.position, 0), 0, duration);
  const completed = Boolean(payload.completed) || position / duration >= 0.95;
  const progress = completed ? 1 : clamp(position / duration, 0, 1);
  const now = new Date();

  const recentView = await prisma.viewHistory.findFirst({
    where: {
      reelId,
      userId,
      watchedAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }
    },
    orderBy: { watchedAt: 'desc' }
  });

  await prisma.$transaction(async tx => {
    await tx.watchProgress.upsert({
      where: { reelId_userId: { reelId, userId } },
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
        where: { id: reelId },
        data: {
          views: { increment: 1 },
          uniqueViews: { increment: 1 },
          watchTime: { increment: position }
        }
      });
    } else if (recentView) {
      await tx.viewHistory.update({
        where: { id: recentView.id },
        data: {
          watchDuration: Math.max(recentView.watchDuration || 0, position),
          completed: recentView.completed || completed,
          watchedAt: now,
          deviceInfo: {
            ...(typeof recentView.deviceInfo === 'object' && recentView.deviceInfo ? recentView.deviceInfo : {}),
            sessionId: payload.sessionId || null,
            muted: Boolean(payload.muted),
            loopCount: normalizeNumber(payload.loopCount, 0)
          }
        } as any
      });

      await tx.reel.update({
        where: { id: reelId },
        data: {
          watchTime: { increment: Math.max(0, position - (recentView.watchDuration || 0)) }
        }
      });
    }

    if (completed) {
      const current = await tx.reel.findUnique({ where: { id: reelId }, select: { views: true, completionRate: true } });
      const views = Math.max(1, current?.views || 1);
      const completionRate = clamp((((current?.completionRate || 0) * Math.max(0, views - 1)) + 1) / views, 0, 1);

      await tx.reel.update({
        where: { id: reelId },
        data: { completionRate }
      });
    }
  });

  const counts = await getEngagementCounts(reelId);
  io.of('/reels').to(roomForReel(reelId)).emit('reel:watch_update', {
    reelId,
    userId,
    progress,
    position,
    completed,
    counts,
    timestamp: now.toISOString()
  });
};

const queueWatchProgress = (io: Server, payload: WatchPayload & { userId: string }) => {
  const reelId = normalizeString(payload.reelId);
  const userId = normalizeString(payload.userId);
  if (!reelId || !userId) return;

  const key = `${reelId}:${userId}:${payload.sessionId || 'default'}`;
  watchBuffer.set(key, { ...payload, reelId, userId, updatedAt: Date.now() });

  if (payload.completed) {
    if (watchFlushTimers.has(key)) clearTimeout(watchFlushTimers.get(key)!);
    watchFlushTimers.delete(key);
    flushWatchProgress(io, key).catch(() => {});
    return;
  }

  if (watchFlushTimers.has(key)) return;

  const timer = setTimeout(() => {
    watchFlushTimers.delete(key);
    flushWatchProgress(io, key).catch(() => {});
  }, 5000);

  watchFlushTimers.set(key, timer);
};

const updateActiveViewer = (io: Server, reelId: string, userId: string, active: boolean) => {
  const room = roomForReel(reelId);
  const viewers = activeViewers.get(reelId) || new Set<string>();

  if (active) viewers.add(userId);
  else viewers.delete(userId);

  if (viewers.size) activeViewers.set(reelId, viewers);
  else activeViewers.delete(reelId);

  io.of('/reels').to(room).emit('reel:active_viewers', {
    reelId,
    count: viewers.size,
    timestamp: new Date().toISOString()
  });
};

const schedulePresenceExpiry = (io: Server, reelId: string, userId: string) => {
  const key = `${reelId}:${userId}`;
  if (reelPresenceTimers.has(key)) clearTimeout(reelPresenceTimers.get(key)!);

  const timer = setTimeout(() => {
    reelPresenceTimers.delete(key);
    updateActiveViewer(io, reelId, userId, false);
  }, 15000);

  reelPresenceTimers.set(key, timer);
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
      trendingScore: { gt: 0 }
    },
    include: {
      author: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
      music: true,
      _count: { select: { comments: true } }
    },
    orderBy: [{ trendingScore: 'desc' }, { publishedAt: 'desc' }],
    take: 20
  });

  io.of('/reels').to(roomForTrending('global')).emit('trending:update', {
    region: 'global',
    reels: trending,
    timestamp: new Date().toISOString()
  });
};

export function initReelSockets(io: Server) {
  const ns = io.of('/reels');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.toString().replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as ReelSocketAuth;
      if (!decoded?.userId) return next(new Error('Authentication required'));

      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role || 'user';
      socket.join(roomForUser(decoded.userId));
      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  ns.on('connection', (socket: Socket) => {
    const userId = normalizeString(socket.data.userId);
    const joinedReels = new Set<string>();

    socket.emit('reel:connected', {
      userId,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });

    socket.on('reel:join', async ({ reelId }, ack) => {
      try {
        reelId = normalizeString(reelId);
        if (!reelId) {
          safeAck(ack, { success: false, error: 'Invalid reel id' });
          return emitSocketError(socket, 'INVALID_REEL_ID', 'Invalid reel id');
        }

        const access = await verifyReelAccess(reelId, userId);
        if (!access.ok) {
          safeAck(ack, { success: false, error: access.error, status: access.status });
          return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
        }

        socket.join(roomForReel(reelId));
        joinedReels.add(reelId);
        updateActiveViewer(io, reelId, userId, true);
        schedulePresenceExpiry(io, reelId, userId);

        const counts = await getEngagementCounts(reelId);
        const progress = await prisma.watchProgress.findUnique({
          where: { reelId_userId: { reelId, userId } },
          select: { progress: true, lastPosition: true, updatedAt: true }
        });

        const payload = {
          success: true,
          reelId,
          counts,
          progress: progress || null,
          activeViewers: activeViewers.get(reelId)?.size || 0,
          timestamp: new Date().toISOString()
        };

        socket.emit('reel:joined', payload);
        safeAck(ack, payload);
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to join reel' });
        emitSocketError(socket, 'JOIN_FAILED', 'Failed to join reel');
      }
    });

    socket.on('reel:leave', ({ reelId }, ack) => {
      reelId = normalizeString(reelId);
      if (!reelId) {
        safeAck(ack, { success: false, error: 'Invalid reel id' });
        return;
      }

      socket.leave(roomForReel(reelId));
      joinedReels.delete(reelId);
      updateActiveViewer(io, reelId, userId, false);
      safeAck(ack, { success: true, reelId });
    });

    socket.on('reel:heartbeat', ({ reelId }, ack) => {
      reelId = normalizeString(reelId);
      if (!reelId || !joinedReels.has(reelId)) {
        safeAck(ack, { success: false, error: 'Not joined' });
        return;
      }

      updateActiveViewer(io, reelId, userId, true);
      schedulePresenceExpiry(io, reelId, userId);
      safeAck(ack, { success: true, reelId, activeViewers: activeViewers.get(reelId)?.size || 0 });
    });

    socket.on('reel:watching', async (payload: WatchPayload, ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);
        if (!reelId) {
          safeAck(ack, { success: false, error: 'Invalid reel id' });
          return emitSocketError(socket, 'INVALID_REEL_ID', 'Invalid reel id');
        }

        if (!joinedReels.has(reelId)) {
          const access = await verifyReelAccess(reelId, userId);
          if (!access.ok) {
            safeAck(ack, { success: false, error: access.error });
            return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
          }
          socket.join(roomForReel(reelId));
          joinedReels.add(reelId);
        }

        updateActiveViewer(io, reelId, userId, true);
        schedulePresenceExpiry(io, reelId, userId);
        queueWatchProgress(io, { ...payload, reelId, userId });
        safeAck(ack, { success: true, queued: true, reelId });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Watch update failed' });
        emitSocketError(socket, 'WATCH_UPDATE_FAILED', 'Watch update failed');
      }
    });

    socket.on('reel:engage', async (payload: EngagePayload, ack) => {
      try {
        const reelId = normalizeString(payload?.reelId);
        const action = payload?.action;

        if (!reelId || !action) {
          safeAck(ack, { success: false, error: 'Invalid engagement payload' });
          return emitSocketError(socket, 'INVALID_ENGAGEMENT', 'Invalid engagement payload');
        }

        const access = await verifyReelAccess(reelId, userId);
        if (!access.ok) {
          safeAck(ack, { success: false, error: access.error });
          return emitSocketError(socket, 'REEL_ACCESS_DENIED', access.error, { reelId });
        }

        const reel = access.reel;

        if (action === 'like') {
          if (!reel.likes.includes(userId)) {
            await prisma.reel.update({ where: { id: reelId }, data: { likes: { push: userId } } });
            if (reel.userId !== userId) {
              ns.to(roomForUser(reel.userId)).emit('notification:like', {
                type: 'reel_like',
                from: userId,
                reelId,
                timestamp: new Date().toISOString()
              });
            }
          }
        }

        if (action === 'unlike') {
          await prisma.reel.update({
            where: { id: reelId },
            data: { likes: { set: reel.likes.filter(id => id !== userId) } }
          });
        }

        if (action === 'share') {
          await prisma.$transaction([
            prisma.reelShare.create({
              data: {
                reelId,
                userId,
                platform: normalizeString(payload.value?.platform) || 'socket'
              }
            }),
            prisma.reel.update({ where: { id: reelId }, data: { shares: { increment: 1 } } })
          ]);
        }

        if (action === 'save') {
          await prisma.reelSave.upsert({
            where: { reelId_userId: { reelId, userId } },
            update: { collectionId: payload.value?.collectionId || null },
            create: { reelId, userId, collectionId: payload.value?.collectionId || null }
          });
        }

        if (action === 'unsave') {
          await prisma.reelSave.deleteMany({ where: { reelId, userId } });
        }

        const counts = await getEngagementCounts(reelId);

        ns.to(roomForReel(reelId)).emit('reel:engagement_update', {
          reelId,
          action,
          userId,
          counts,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, reelId, action, counts });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Engagement failed' });
        emitSocketError(socket, 'ENGAGEMENT_FAILED', 'Engagement failed');
      }
    });

    socket.on('reel:request_stats', async ({ reelId }, ack) => {
      try {
        reelId = normalizeString(reelId);
        if (!reelId) {
          safeAck(ack, { success: false, error: 'Invalid reel id' });
          return;
        }

        const access = await verifyReelAccess(reelId, userId);
        if (!access.ok) {
          safeAck(ack, { success: false, error: access.error });
          return;
        }

        const counts = await getEngagementCounts(reelId);
        const progress = await prisma.watchProgress.findUnique({
          where: { reelId_userId: { reelId, userId } },
          select: { progress: true, lastPosition: true, updatedAt: true }
        });

        const payload = {
          success: true,
          reelId,
          counts,
          progress: progress || null,
          activeViewers: activeViewers.get(reelId)?.size || 0,
          timestamp: new Date().toISOString()
        };

        socket.emit('reel:stats', payload);
        safeAck(ack, payload);
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Stats failed' });
      }
    });

    socket.on('reel:request_views', async ({ reelId }, ack) => {
      try {
        reelId = normalizeString(reelId);
        const counts = reelId ? await getEngagementCounts(reelId) : null;
        const payload = { success: !!counts, reelId, views: counts?.views || 0, uniqueViews: counts?.uniqueViews || 0 };
        socket.emit('reel:view_count', payload);
        safeAck(ack, payload);
      } catch {
        safeAck(ack, { success: false, error: 'Failed to load views' });
      }
    });

    socket.on('comment:typing:start', async ({ reelId }, ack) => {
      reelId = normalizeString(reelId);
      if (!reelId) {
        safeAck(ack, { success: false, error: 'Invalid reel id' });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatarUrl: true, isVerified: true } });
      ns.to(roomForReel(reelId)).except(socket.id).emit('comment:typing', {
        reelId,
        userId,
        user,
        isTyping: true,
        timestamp: new Date().toISOString()
      });

      safeAck(ack, { success: true });
    });

    socket.on('comment:typing:stop', ({ reelId }, ack) => {
      reelId = normalizeString(reelId);
      if (!reelId) {
        safeAck(ack, { success: false, error: 'Invalid reel id' });
        return;
      }

      ns.to(roomForReel(reelId)).except(socket.id).emit('comment:typing', {
        reelId,
        userId,
        isTyping: false,
        timestamp: new Date().toISOString()
      });

      safeAck(ack, { success: true });
    });

    socket.on('trending:subscribe', ({ region = 'global' }, ack) => {
      region = normalizeString(region) || 'global';
      socket.join(roomForTrending(region));
      safeAck(ack, { success: true, region });
    });

    socket.on('trending:unsubscribe', ({ region = 'global' }, ack) => {
      region = normalizeString(region) || 'global';
      socket.leave(roomForTrending(region));
      safeAck(ack, { success: true, region });
    });

    socket.on('creator:subscribe', ({ creatorId }, ack) => {
      creatorId = normalizeString(creatorId);
      if (!creatorId) {
        safeAck(ack, { success: false, error: 'Invalid creator id' });
        return;
      }

      socket.join(`creator:${creatorId}`);
      safeAck(ack, { success: true, creatorId });
    });

    socket.on('creator:unsubscribe', ({ creatorId }, ack) => {
      creatorId = normalizeString(creatorId);
      if (!creatorId) {
        safeAck(ack, { success: false, error: 'Invalid creator id' });
        return;
      }

      socket.leave(`creator:${creatorId}`);
      safeAck(ack, { success: true, creatorId });
    });

    socket.on('disconnect', () => {
      for (const reelId of joinedReels) {
        updateActiveViewer(io, reelId, userId, false);
        const key = `${reelId}:${userId}`;
        if (reelPresenceTimers.has(key)) {
          clearTimeout(reelPresenceTimers.get(key)!);
          reelPresenceTimers.delete(key);
        }
      }

      for (const [key, payload] of watchBuffer.entries()) {
        if (payload.userId === userId) {
          if (watchFlushTimers.has(key)) {
            clearTimeout(watchFlushTimers.get(key)!);
            watchFlushTimers.delete(key);
          }
          flushWatchProgress(io, key).catch(() => {});
        }
      }

      joinedReels.clear();
    });
  });

  if (!trendingIntervals.has(io)) {
    const interval = setInterval(() => {
      broadcastTrending(io).catch(() => {});
    }, 5 * 60 * 1000);

    trendingIntervals.set(io, interval);
  }
}
