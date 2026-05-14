import { Server, Socket, Namespace } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';

type NotificationAuthPayload = {
  userId?: string;
  id?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

type Ack<T = any> = (response: T) => void;

type MarkReadPayload = {
  notificationIds?: string[];
};

type DeletePayload = {
  notificationIds?: string[];
};

type PreferencePayload = {
  pushEnabled?: boolean;
  emailEnabled?: boolean;
  inAppEnabled?: boolean;
  marketingEnabled?: boolean;
  orderEnabled?: boolean;
  messageEnabled?: boolean;
  securityEnabled?: boolean;
  commerceEnabled?: boolean;
  systemEnabled?: boolean;
};

const USER_ROOM_PREFIX = 'user';
const ADMIN_ROOM = 'admin:notifications';
const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 100;
const MAX_NOTIFICATION_BATCH = 100;

const socketBuckets = new Map<string, { count: number; resetAt: number }>();
const onlineUsers = new Map<string, number>();

function safeAck(ack: Ack | undefined, response: any) {
  if (typeof ack === 'function') ack(response);
}

function room(prefix: string, id: string) {
  return `${prefix}:${id}`;
}

function isValidId(value: any) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const headerToken = socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, '');
  const queryToken = socket.handshake.query?.token;

  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return '';
}

function getJWTSecret() {
  const secret = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw new Error('JWT secret missing');
  return secret;
}

function isAdminRole(role?: string | null) {
  const normalized = String(role || '').toLowerCase();
  return ['admin', 'super_admin', 'superadmin', 'owner'].includes(normalized);
}

function rateLimit(socket: Socket) {
  const key = socket.id;
  const now = Date.now();
  const bucket = socketBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    socketBuckets.set(key, { count: 1, resetAt: now + SOCKET_RATE_LIMIT_WINDOW });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= SOCKET_RATE_LIMIT_MAX;
}

function bindRateLimit(socket: Socket) {
  socket.use((packet, next) => {
    if (!rateLimit(socket)) {
      socket.emit('notification:error', {
        code: 'RATE_LIMITED',
        message: 'Too many socket events',
        at: new Date().toISOString()
      });
      return;
    }

    next();
  });
}

function cleanIds(ids: any) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(isValidId))].slice(0, MAX_NOTIFICATION_BATCH);
}

async function getActiveUser(userId: string, fallbackRole?: string | null) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isBanned: true
    } as any
  }).catch(() => null);

  if (!user || (user as any).isBanned) return null;

  return {
    id: user.id,
    role: String((user as any).role || fallbackRole || '').toLowerCase()
  };
}

async function getUnreadCount(userId: string) {
  return prisma.notification.count({
    where: {
      userId,
      read: false
    } as any
  }).catch(() => 0);
}

async function emitUnreadCount(ns: Namespace, userId: string) {
  const unread = await getUnreadCount(userId);

  ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:unread_count', {
    unread,
    timestamp: new Date().toISOString()
  });

  return unread;
}

async function getRecentNotifications(userId: string, limit = 30) {
  return prisma.notification.findMany({
    where: { userId } as any,
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(Number(limit) || 30, 100))
  }).catch(() => []);
}

async function ensurePreferenceRow(userId: string) {
  const model = (prisma as any).notificationPreference || (prisma as any).notificationPreferences;

  if (!model?.upsert) return null;

  return model.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
      marketingEnabled: false,
      orderEnabled: true,
      messageEnabled: true,
      securityEnabled: true,
      commerceEnabled: true,
      systemEnabled: true
    }
  }).catch(() => null);
}

async function updatePreferences(userId: string, payload: PreferencePayload) {
  const model = (prisma as any).notificationPreference || (prisma as any).notificationPreferences;

  if (!model?.upsert) return null;

  const data: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (typeof value === 'boolean') data[key] = value;
  }

  if (!Object.keys(data).length) return ensurePreferenceRow(userId);

  return model.upsert({
    where: { userId },
    update: data,
    create: {
      userId,
      pushEnabled: data.pushEnabled ?? true,
      emailEnabled: data.emailEnabled ?? true,
      inAppEnabled: data.inAppEnabled ?? true,
      marketingEnabled: data.marketingEnabled ?? false,
      orderEnabled: data.orderEnabled ?? true,
      messageEnabled: data.messageEnabled ?? true,
      securityEnabled: data.securityEnabled ?? true,
      commerceEnabled: data.commerceEnabled ?? true,
      systemEnabled: data.systemEnabled ?? true
    }
  }).catch(() => null);
}

export function initNotificationSockets(io: Server) {
  const ns = io.of('/notifications');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, getJWTSecret()) as NotificationAuthPayload;
      const userId = decoded?.userId || decoded?.id;

      if (!userId || !isValidId(userId)) {
        return next(new Error('Invalid token'));
      }

      const user = await getActiveUser(userId, decoded.role);

      if (!user) {
        return next(new Error('User blocked or not found'));
      }

      socket.data.userId = user.id;
      socket.data.role = user.role;

      return next();
    } catch {
      return next(new Error('Invalid token'));
    }
  });

  ns.on('connection', async (socket: Socket) => {
    try {
      const userId = socket.data.userId as string;
      const role = socket.data.role as string | undefined;

      bindRateLimit(socket);

      socket.join(room(USER_ROOM_PREFIX, userId));

      if (isAdminRole(role)) {
        socket.join(ADMIN_ROOM);
      }

      onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);

      socket.emit('notification:connected', {
        userId,
        role: role || null,
        socketId: socket.id,
        connectedAt: new Date().toISOString()
      });

      const [unread, recent, preferences] = await Promise.all([
        getUnreadCount(userId),
        getRecentNotifications(userId, 30),
        ensurePreferenceRow(userId)
      ]);

      socket.emit('notification:bootstrap', {
        unread,
        recent,
        preferences,
        timestamp: new Date().toISOString()
      });

      socket.on('notification:list', async ({ limit }: { limit?: number } = {}, ack?: Ack) => {
        try {
          const notifications = await getRecentNotifications(userId, limit || 30);
          const unread = await getUnreadCount(userId);

          safeAck(ack, {
            success: true,
            notifications,
            unread
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to load notifications'
          });
        }
      });

      socket.on('mark_read', async (payload: string[] | MarkReadPayload = {}, ack?: Ack) => {
        try {
          const ids = Array.isArray(payload) ? cleanIds(payload) : cleanIds(payload.notificationIds);

          if (!ids.length) {
            return safeAck(ack, {
              success: false,
              error: 'notificationIds are required'
            });
          }

          const result = await prisma.notification.updateMany({
            where: {
              id: { in: ids },
              userId
            } as any,
            data: {
              read: true,
              readAt: new Date()
            } as any
          });

          const unread = await emitUnreadCount(ns, userId);

          ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:read', {
            notificationIds: ids,
            count: result.count,
            unread,
            timestamp: new Date().toISOString()
          });

          safeAck(ack, {
            success: true,
            count: result.count,
            unread
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to mark notifications as read'
          });
        }
      });

      socket.on('notification:mark_read', async (payload: MarkReadPayload = {}, ack?: Ack) => {
        socket.emit('mark_read_proxy', payload);
        const ids = cleanIds(payload.notificationIds);

        if (!ids.length) {
          return safeAck(ack, {
            success: false,
            error: 'notificationIds are required'
          });
        }

        try {
          const result = await prisma.notification.updateMany({
            where: {
              id: { in: ids },
              userId
            } as any,
            data: {
              read: true,
              readAt: new Date()
            } as any
          });

          const unread = await emitUnreadCount(ns, userId);

          ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:read', {
            notificationIds: ids,
            count: result.count,
            unread,
            timestamp: new Date().toISOString()
          });

          safeAck(ack, {
            success: true,
            count: result.count,
            unread
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to mark notifications as read'
          });
        }
      });

      socket.on('notification:mark_all_read', async (_payload: any = {}, ack?: Ack) => {
        try {
          const result = await prisma.notification.updateMany({
            where: {
              userId,
              read: false
            } as any,
            data: {
              read: true,
              readAt: new Date()
            } as any
          });

          ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:all_read', {
            count: result.count,
            unread: 0,
            timestamp: new Date().toISOString()
          });

          safeAck(ack, {
            success: true,
            count: result.count,
            unread: 0
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to mark all notifications as read'
          });
        }
      });

      socket.on('notification:delete', async (payload: DeletePayload = {}, ack?: Ack) => {
        try {
          const ids = cleanIds(payload.notificationIds);

          if (!ids.length) {
            return safeAck(ack, {
              success: false,
              error: 'notificationIds are required'
            });
          }

          const result = await prisma.notification.deleteMany({
            where: {
              id: { in: ids },
              userId
            } as any
          });

          const unread = await emitUnreadCount(ns, userId);

          ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:deleted', {
            notificationIds: ids,
            count: result.count,
            unread,
            timestamp: new Date().toISOString()
          });

          safeAck(ack, {
            success: true,
            count: result.count,
            unread
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to delete notifications'
          });
        }
      });

      socket.on('notification:preferences:get', async (_payload: any = {}, ack?: Ack) => {
        try {
          const preferences = await ensurePreferenceRow(userId);

          safeAck(ack, {
            success: true,
            preferences
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to load notification preferences'
          });
        }
      });

      socket.on('notification:preferences:update', async (payload: PreferencePayload = {}, ack?: Ack) => {
        try {
          const preferences = await updatePreferences(userId, payload);

          socket.emit('notification:preferences:updated', {
            preferences,
            timestamp: new Date().toISOString()
          });

          safeAck(ack, {
            success: true,
            preferences
          });
        } catch (error: any) {
          safeAck(ack, {
            success: false,
            error: error?.message || 'Failed to update notification preferences'
          });
        }
      });

      socket.on('notification:ping', (_payload: any = {}, ack?: Ack) => {
        safeAck(ack, {
          success: true,
          userId,
          online: true,
          timestamp: new Date().toISOString()
        });
      });

      socket.on('disconnect', async () => {
        socketBuckets.delete(socket.id);

        const count = Math.max((onlineUsers.get(userId) || 1) - 1, 0);

        if (count <= 0) {
          onlineUsers.delete(userId);
        } else {
          onlineUsers.set(userId, count);
        }
      });
    } catch {
      socket.disconnect(true);
    }
  });

  return ns;
}

export function emitNotificationToUser(io: Server, userId: string, notification: any) {
  if (!isValidId(userId)) return;

  const ns = io.of('/notifications');

  ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:new', {
    notification,
    timestamp: new Date().toISOString()
  });

  emitUnreadCount(ns, userId).catch(() => null);
}

export function emitNotificationRead(io: Server, userId: string, notificationIds: string[]) {
  if (!isValidId(userId)) return;

  const ids = cleanIds(notificationIds);
  if (!ids.length) return;

  const ns = io.of('/notifications');

  ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:read', {
    notificationIds: ids,
    timestamp: new Date().toISOString()
  });

  emitUnreadCount(ns, userId).catch(() => null);
}

export function emitNotificationDeleted(io: Server, userId: string, notificationIds: string[]) {
  if (!isValidId(userId)) return;

  const ids = cleanIds(notificationIds);
  if (!ids.length) return;

  const ns = io.of('/notifications');

  ns.to(room(USER_ROOM_PREFIX, userId)).emit('notification:deleted', {
    notificationIds: ids,
    timestamp: new Date().toISOString()
  });

  emitUnreadCount(ns, userId).catch(() => null);
}

export function emitBroadcastNotification(io: Server, notification: any) {
  io.of('/notifications').emit('notification:broadcast', {
    notification,
    timestamp: new Date().toISOString()
  });
}

export function emitAdminNotification(io: Server, notification: any) {
  io.of('/notifications').to(ADMIN_ROOM).emit('notification:admin', {
    notification,
    timestamp: new Date().toISOString()
  });
}

export function getNotificationRoom(userId: string) {
  return room(USER_ROOM_PREFIX, userId);
}

export function isNotificationUserOnline(userId: string) {
  return (onlineUsers.get(userId) || 0) > 0;
}
