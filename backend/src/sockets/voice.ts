import { Server, Socket, Namespace } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ZodError } from 'zod';
import { prisma } from '../config/db';
import { redis, cache } from '../config/redis';
import { RoomManager } from '../services/voice/manager';
import { processGift, validateCoinBalance } from '../services/voice/economy';
import { trackRoomEvent, flushRoomAnalytics } from '../services/voice/analytics';
import { roomSchema, chatSchema, giftSchema, seatSchema, hostActionSchema } from '../utils/validators/voice';

type Ack<T = any> = (response?: T) => void;

type VoiceSocketData = {
  userId: string;
  role: string;
  currentRoom?: string | null;
  joinedAt?: number;
  lastHeartbeatAt?: number;
};

type SafeUser = {
  id: string;
  username: string | null;
  fullName?: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  level?: string | null;
};

type RoomPoll = {
  id: string;
  roomId: string;
  question: string;
  options: Array<{ id: string; text: string; count: number }>;
  votes: Record<string, number>;
  totalVotes: number;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

const ROOM_USER_TTL = 60 * 60 * 6;
const ROOM_STATE_TTL = 30;
const ROOM_POLL_TTL = 300;
const MAX_SEATS = 10;
const MAX_CHAT_LENGTH = 500;
const MAX_TYPING_TTL = 5;
const SOCKET_RATE_WINDOW = 10;
const SOCKET_RATE_LIMIT = 80;
const VOICE_ACTIVITY_RATE_WINDOW = 2;
const VOICE_ACTIVITY_RATE_LIMIT = 40;
const ROOM_HEARTBEAT_STALE_MS = 45_000;
const ANALYTICS_FLUSH_MS = 60_000;

const voiceIntervals = new WeakMap<Server, NodeJS.Timeout>();

function safeAck<T>(ack?: Ack<T>, response?: T) {
  if (typeof ack === 'function') {
    try {
      ack(response);
    } catch {}
  }
}

function normalizeError(err: any) {
  if (err instanceof ZodError) return 'Invalid request data';
  if (err?.message) return String(err.message);
  return 'Something went wrong';
}

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET || '';
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

function isAdminRole(role?: string) {
  return role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'MODERATOR';
}

function normalizeString(value: any, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeBoolean(value: any) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeVolume(value: any) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isValidId(value: any) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

async function redisSafe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function cacheGet<T>(key: string) {
  try {
    return await cache.get<T>(key);
  } catch {
    return null;
  }
}

async function cacheSet<T>(key: string, value: T, ttl: number) {
  try {
    await cache.set(key, value, ttl);
  } catch {}
}

async function rateLimitSocket(socket: Socket, event: string, limit = SOCKET_RATE_LIMIT, windowSeconds = SOCKET_RATE_WINDOW) {
  const userId = socket.data.userId || socket.id;
  const key = `voice:socket_rate:${userId}:${event}`;
  const count = await redisSafe(() => redis.incr(key), 1);

  if (count === 1) {
    await redisSafe(() => redis.expire(key, windowSeconds), 1);
  }

  return count <= limit;
}

async function getSafeUser(userId: string): Promise<SafeUser | null> {
  if (!isValidId(userId)) return null;

  const cached = await cacheGet<SafeUser>(`voice:user:${userId}`);
  if (cached) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      level: true
    } as any
  }).catch(() => null);

  if (user) await cacheSet(`voice:user:${userId}`, user as SafeUser, 120);

  return user as SafeUser | null;
}

async function isRoomMember(roomId: string, userId: string) {
  if (!isValidId(roomId) || !isValidId(userId)) return false;

  const exists = await redisSafe(() => redis.sismember(`room:${roomId}:users`, userId), 0);
  if (exists) return true;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentRoomId: true }
  }).catch(() => null);

  if (user?.currentRoomId === roomId) return true;

  const seat = await prisma.seat.findFirst({
    where: { roomId, userId },
    select: { id: true }
  }).catch(() => null);

  return !!seat;
}

async function isRoomHostOrAdmin(roomId: string, userId: string, role?: string) {
  if (isAdminRole(role)) return true;

  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    select: { hostId: true }
  }).catch(() => null);

  if (room?.hostId === userId) return true;

  const seat = await prisma.seat.findFirst({
    where: { roomId, userId },
    select: { isHost: true, isModerator: true }
  }).catch(() => null);

  return !!seat?.isHost || !!seat?.isModerator;
}

async function getOnlineCount(roomId: string) {
  return redisSafe(() => redis.scard(`room:${roomId}:users`), 0);
}

async function getRoomState(roomId: string) {
  const state = await RoomManager.getRoomState(roomId);
  const onlineCount = await getOnlineCount(roomId);
  return { ...state, onlineCount };
}

async function syncRoom(ns: Namespace, roomId: string) {
  const state = await getRoomState(roomId);
  await cacheSet(`room:${roomId}:state`, state, ROOM_STATE_TTL);
  ns.to(roomId).emit('room:sync', state);
  return state;
}

async function ensureConversationForRoom(roomId: string) {
  const conversationId = `room_${roomId}`;

  const existing = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true }
  }).catch(() => null);

  if (existing) return conversationId;

  await prisma.conversation.create({
    data: {
      id: conversationId,
      type: 'ROOM' as any,
      title: `Voice Room ${roomId}`
    } as any
  }).catch(() => null);

  return conversationId;
}

async function removeUserFromRoomStorage(roomId: string, userId: string) {
  await Promise.all([
    redisSafe(() => redis.srem(`room:${roomId}:users`, userId), 0),
    redisSafe(() => redis.hdel(`room:${roomId}:presence`, userId), 0),
    redisSafe(() => redis.hdel(`room:${roomId}:voice_activity`, userId), 0),
    redisSafe(() => redis.hdel(`room:${roomId}:mic`, userId), 0),
    redisSafe(() => redis.hdel(`room:${roomId}:voice_effects`, userId), 0),
    redisSafe(() => redis.del(`room:${roomId}:typing:${userId}`), 0),
    redisSafe(() => redis.hdel(`room:${roomId}:seats`, userId), 0)
  ]);
}

async function leaveCurrentRoom(ns: Namespace, socket: Socket, reason = 'leave') {
  const userId = socket.data.userId as string;
  const currentRoom = socket.data.currentRoom as string | null | undefined;

  if (!currentRoom) return null;

  await RoomManager.leaveSeat(currentRoom, userId).catch(() => null);
  await removeUserFromRoomStorage(currentRoom, userId);

  await prisma.user.updateMany({
    where: { id: userId },
    data: { currentRoomId: null } as any
  }).catch(() => null);

  socket.leave(currentRoom);

  const user = await getSafeUser(userId);
  const onlineCount = await getOnlineCount(currentRoom);

  ns.to(currentRoom).emit('room:user_left', {
    userId,
    user,
    reason,
    onlineCount,
    serverTime: Date.now()
  });

  ns.to(currentRoom).emit('presence:update', {
    userId,
    isOnline: false,
    roomId: currentRoom,
    onlineCount,
    serverTime: Date.now()
  });

  await trackRoomEvent(currentRoom, 'leave', { userId, reason }).catch(() => null);
  await syncRoom(ns, currentRoom).catch(() => null);

  socket.data.currentRoom = null;

  return currentRoom;
}

async function joinRoomStorage(roomId: string, userId: string, socketId: string) {
  await redisSafe(() => redis.sadd(`room:${roomId}:users`, userId), 0);
  await redisSafe(() => redis.expire(`room:${roomId}:users`, ROOM_USER_TTL), 0);

  await redisSafe(
    () =>
      redis.hset(
        `room:${roomId}:presence`,
        userId,
        JSON.stringify({
          userId,
          socketId,
          joinedAt: Date.now(),
          lastSeen: Date.now()
        })
      ),
    0
  );

  await redisSafe(() => redis.expire(`room:${roomId}:presence`, ROOM_USER_TTL), 0);
}

async function canJoinRoom(room: any, userId: string) {
  if (!room) return { ok: false, error: 'Room not found or inactive' };
  if (room.isActive === false || room.status === 'ENDED' || room.status === 'CLOSED') return { ok: false, error: 'Room not found or inactive' };
  if (room.isLocked && room.hostId !== userId) return { ok: false, error: 'Room is locked' };

  const blocked = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: room.hostId, blockedId: userId },
        { blockerId: userId, blockedId: room.hostId }
      ]
    },
    select: { id: true }
  }).catch(() => null);

  if (blocked) return { ok: false, error: 'You cannot join this room' };

  return { ok: true, error: null };
}

async function getRoomForJoin(roomId: string) {
  const managed = await RoomManager.getRoom(roomId).catch(() => null);
  if (managed) return managed;

  return prisma.voiceRoom.findFirst({
    where: {
      id: roomId,
      isActive: true
    } as any
  }).catch(() => null);
}

async function broadcastSeats(ns: Namespace, roomId: string) {
  const seats = await RoomManager.getSeats(roomId).catch(() => []);
  ns.to(roomId).emit('seats:update', { seats, serverTime: Date.now() });
  return seats;
}

async function kickSocketFromRoom(ns: Namespace, roomId: string, targetId: string, by: string) {
  await RoomManager.leaveSeat(roomId, targetId).catch(() => null);
  await removeUserFromRoomStorage(roomId, targetId);

  await prisma.user.updateMany({
    where: { id: targetId },
    data: { currentRoomId: null } as any
  }).catch(() => null);

  ns.to(`user:${targetId}`).emit('room:kicked', {
    roomId,
    by,
    serverTime: Date.now()
  });
}

function makePoll(roomId: string, userId: string, data: any): RoomPoll | null {
  const question = normalizeString(data?.question, 160);
  const options = Array.isArray(data?.options)
    ? data.options
        .slice(0, 6)
        .map((option: any, index: number) => ({
          id: String(index),
          text: normalizeString(option, 80),
          count: 0
        }))
        .filter((option: any) => option.text)
    : [];

  if (!question || options.length < 2) return null;

  return {
    id: `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    roomId,
    question,
    options,
    votes: {},
    totalVotes: 0,
    createdBy: userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_POLL_TTL * 1000
  };
}

export function initVoiceNamespace(io: Server) {
  const ns = io.of('/voice');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);
      const secret = getJwtSecret();

      if (!token || !secret) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, secret) as { userId?: string; id?: string; sub?: string; role?: string };
      const userId = decoded.userId || decoded.id || decoded.sub;

      if (!userId || !isValidId(userId)) return next(new Error('Authentication required'));

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, isBanned: true }
      } as any).catch(() => null);

      if (!user || (user as any).isBanned) return next(new Error('Authentication required'));

      socket.data.userId = user.id;
      socket.data.role = String((user as any).role || decoded.role || 'USER');
      socket.data.currentRoom = null;
      socket.data.joinedAt = Date.now();
      socket.data.lastHeartbeatAt = Date.now();

      socket.join(`user:${user.id}`);

      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  ns.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;

    socket.emit('voice:connected', {
      userId,
      socketId: socket.id,
      serverTime: Date.now()
    });

    socket.on('room:join', async (data: { roomId: string }, ack?: Ack) => {
      try {
        if (!(await rateLimitSocket(socket, 'room_join', 20, 60))) {
          return safeAck(ack, { success: false, error: 'Too many room joins' });
        }

        const { roomId } = roomSchema.parse(data);

        if (!isValidId(roomId)) return safeAck(ack, { success: false, error: 'Invalid room' });

        const room = await getRoomForJoin(roomId);
        const joinCheck = await canJoinRoom(room, userId);

        if (!joinCheck.ok) return safeAck(ack, { success: false, error: joinCheck.error });

        if (socket.data.currentRoom && socket.data.currentRoom !== roomId) {
          await leaveCurrentRoom(ns, socket, 'switch_room');
        }

        socket.data.currentRoom = roomId;
        socket.data.lastHeartbeatAt = Date.now();
        socket.join(roomId);

        await joinRoomStorage(roomId, userId, socket.id);

        await prisma.user.updateMany({
          where: { id: userId },
          data: { currentRoomId: roomId } as any
        }).catch(() => null);

        const user = await getSafeUser(userId);
        const state = await syncRoom(ns, roomId);

        ns.to(roomId).emit('room:user_joined', {
          userId,
          user,
          seat: state.seats?.find((seat: any) => seat.userId === userId) || null,
          onlineCount: state.onlineCount,
          serverTime: Date.now()
        });

        ns.to(roomId).emit('presence:update', {
          userId,
          user,
          isOnline: true,
          roomId,
          onlineCount: state.onlineCount,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'join', { userId, socketId: socket.id }).catch(() => null);

        safeAck(ack, { success: true, roomId, state });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:leave', async (ack?: Ack) => {
      try {
        const roomId = await leaveCurrentRoom(ns, socket);
        safeAck(ack, { success: true, roomId });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:heartbeat', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        socket.data.lastHeartbeatAt = Date.now();

        await redisSafe(
          () =>
            redis.hset(
              `room:${roomId}:presence`,
              userId,
              JSON.stringify({
                userId,
                socketId: socket.id,
                lastSeen: Date.now()
              })
            ),
          0
        );

        await redisSafe(() => redis.expire(`room:${roomId}:presence`, ROOM_USER_TTL), 0);

        safeAck(ack, {
          success: true,
          serverTime: Date.now()
        });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:state', async (data: { roomId?: string }, ack?: Ack) => {
      try {
        const roomId = data?.roomId || socket.data.currentRoom;

        if (!roomId || !isValidId(roomId)) return safeAck(ack, { success: false, error: 'Room required' });

        const cached = await cacheGet(`room:${roomId}:state`);

        if (cached) return safeAck(ack, { success: true, state: cached });

        const state = await syncRoom(ns, roomId);

        safeAck(ack, { success: true, state });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:take', async (data: { roomId?: string; seatIndex?: number }, ack?: Ack) => {
      try {
        if (!(await rateLimitSocket(socket, 'seat_take', 15, 60))) {
          return safeAck(ack, { success: false, error: 'Too many seat actions' });
        }

        const parsed = seatSchema.parse({
          roomId: data?.roomId || socket.data.currentRoom,
          seatIndex: data?.seatIndex
        });

        const roomId = parsed.roomId;

        if (!roomId || !isValidId(roomId)) return safeAck(ack, { success: false, error: 'Room required' });

        const member = await isRoomMember(roomId, userId);
        if (!member) return safeAck(ack, { success: false, error: 'Join room first' });

        const room = await prisma.voiceRoom.findFirst({
          where: { id: roomId, isActive: true } as any
        }).catch(() => null);

        if (!room) return safeAck(ack, { success: false, error: 'Invalid room' });

        const alreadySeated = await prisma.seat.findFirst({
          where: { roomId, userId }
        }).catch(() => null);

        if (alreadySeated) return safeAck(ack, { success: true, seat: alreadySeated });

        const seatCount = await prisma.seat.count({ where: { roomId } });
        const maxSeats = Number((room as any).maxSeats || MAX_SEATS);

        if (seatCount >= maxSeats) return safeAck(ack, { success: false, error: 'Room full' });

        const requestedIndex = typeof parsed.seatIndex === 'number' ? parsed.seatIndex : seatCount;
        const safeSeatIndex = Math.max(0, Math.min(maxSeats - 1, requestedIndex));

        const existingIndex = await prisma.seat.findFirst({
          where: { roomId, seatIndex: safeSeatIndex },
          select: { id: true }
        }).catch(() => null);

        if (existingIndex) return safeAck(ack, { success: false, error: 'Seat already taken' });

        const isFirstSeat = seatCount === 0 || (room as any).hostId === userId;

        const seat = await prisma.seat.create({
          data: {
            roomId,
            userId,
            seatIndex: safeSeatIndex,
            isHost: isFirstSeat,
            isModerator: isFirstSeat,
            isMuted: false,
            isSpeaking: false,
            handRaised: false
          } as any
        });

        await redisSafe(() => redis.hset(`room:${roomId}:seats`, userId, JSON.stringify(seat)), 0);
        await redisSafe(() => redis.expire(`room:${roomId}:seats`, ROOM_USER_TTL), 0);

        const user = await getSafeUser(userId);
        const seats = await broadcastSeats(ns, roomId);

        ns.to(roomId).emit('seat:taken', {
          seat,
          user,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'seat_taken', { userId, seatId: seat.id, seatIndex: seat.seatIndex }).catch(() => null);
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, seat, seats });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:leave', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        await RoomManager.leaveSeat(roomId, userId).catch(() => null);
        await redisSafe(() => redis.hdel(`room:${roomId}:seats`, userId), 0);

        const seats = await broadcastSeats(ns, roomId);

        ns.to(roomId).emit('seat:left', {
          userId,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'seat_left', { userId }).catch(() => null);
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, seats });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:raise_hand', async (data: { raised?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const raised = data?.raised !== false;

        await prisma.seat.updateMany({
          where: { roomId, userId },
          data: { handRaised: raised } as any
        });

        ns.to(roomId).emit('seat:hand_update', {
          userId,
          handRaised: raised,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, raised ? 'hand_raised' : 'hand_lowered', { userId }).catch(() => null);
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('mic:toggle', async (data: { isMuted: boolean; isPushToTalk?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const seat = await prisma.seat.findFirst({
          where: { roomId, userId }
        }).catch(() => null);

        if (!seat) return safeAck(ack, { success: false, error: 'Take a seat first' });

        const isMuted = normalizeBoolean(data?.isMuted);
        const isPushToTalk = normalizeBoolean(data?.isPushToTalk);

        await prisma.seat.updateMany({
          where: { roomId, userId },
          data: { isMuted } as any
        });

        await redisSafe(
          () =>
            redis.hset(
              `room:${roomId}:mic`,
              userId,
              JSON.stringify({
                isMuted,
                isPushToTalk,
                updatedAt: Date.now()
              })
            ),
          0
        );

        ns.to(roomId).emit('mic:update', {
          userId,
          isMuted,
          isPushToTalk,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'mic_toggle', { userId, isMuted, isPushToTalk }).catch(() => null);
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('voice:activity', async (data: { isSpeaking: boolean; volume: number }) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return;

        if (!(await rateLimitSocket(socket, 'voice_activity', VOICE_ACTIVITY_RATE_LIMIT, VOICE_ACTIVITY_RATE_WINDOW))) return;

        const volume = normalizeVolume(data?.volume);
        const isSpeaking = normalizeBoolean(data?.isSpeaking);

        await redisSafe(
          () =>
            redis.hset(
              `room:${roomId}:voice_activity`,
              userId,
              JSON.stringify({
                isSpeaking,
                volume,
                updatedAt: Date.now()
              })
            ),
          0
        );

        await redisSafe(() => redis.expire(`room:${roomId}:voice_activity`, 30), 0);

        socket.to(roomId).emit('voice:activity', {
          userId,
          isSpeaking,
          volume,
          serverTime: Date.now()
        });
      } catch {}
    });

    socket.on('voice:effect', async (data: { type: 'bass' | 'pitch' | 'robot' | 'clear' | 'studio' | 'echo' | 'cinema'; enabled: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const seat = await prisma.seat.findFirst({
          where: { roomId, userId }
        }).catch(() => null);

        if (!seat) return safeAck(ack, { success: false, error: 'Take a seat first' });

        const allowed = ['bass', 'pitch', 'robot', 'clear', 'studio', 'echo', 'cinema'];
        const type = normalizeString(data?.type, 30);

        if (!allowed.includes(type)) return safeAck(ack, { success: false, error: 'Invalid effect' });

        const enabled = normalizeBoolean(data?.enabled);

        await redisSafe(
          () =>
            redis.hset(
              `room:${roomId}:voice_effects`,
              userId,
              JSON.stringify({
                type,
                enabled,
                updatedAt: Date.now()
              })
            ),
          0
        );

        ns.to(roomId).emit('voice:effect', {
          userId,
          type,
          enabled,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'voice_effect', { userId, type, enabled }).catch(() => null);

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:send', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        if (!(await rateLimitSocket(socket, 'chat_send', 30, 30))) {
          return safeAck(ack, { success: false, error: 'Slow down' });
        }

        const validated = chatSchema.parse(data);
        const content = normalizeString(validated.content, MAX_CHAT_LENGTH);
        const mediaUrl = normalizeString(validated.mediaUrl, 1000) || null;
        const replyToId = normalizeString(validated.replyToId, 128) || null;

        if (!content && !mediaUrl) return safeAck(ack, { success: false, error: 'Message required' });
        if (content.length > MAX_CHAT_LENGTH) return safeAck(ack, { success: false, error: 'Message too long' });

        const member = await isRoomMember(roomId, userId);
        if (!member) return safeAck(ack, { success: false, error: 'Join room first' });

        const conversationId = await ensureConversationForRoom(roomId);

        const msg = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            content,
            mediaUrl,
            replyToId,
            status: 'DELIVERED',
            metadata: {
              source: 'voice_room',
              roomId,
              clientId: validated.clientId || null
            }
          } as any,
          include: {
            sender: {
              select: {
                id: true,
                username: true,
                fullName: true,
                avatarUrl: true,
                isVerified: true
              } as any
            }
          }
        });

        await redisSafe(() => redis.lpush(`room:${roomId}:recent_messages`, JSON.stringify(msg)), 0);
        await redisSafe(() => redis.ltrim(`room:${roomId}:recent_messages`, 0, 49), 'OK');
        await redisSafe(() => redis.expire(`room:${roomId}:recent_messages`, ROOM_USER_TTL), 0);

        ns.to(roomId).emit('chat:new', {
          ...msg,
          timestamp: Date.now()
        });

        await trackRoomEvent(roomId, 'chat_message', {
          userId,
          messageId: msg.id,
          contentLength: content.length,
          hasMedia: !!mediaUrl
        }).catch(() => null);

        safeAck(ack, { success: true, message: msg });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:reaction', async (data: { messageId: string; emoji: string; remove?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const messageId = normalizeString(data?.messageId, 128);
        const emoji = normalizeString(data?.emoji, 32);

        if (!messageId || !emoji) return safeAck(ack, { success: false, error: 'Invalid reaction' });

        const message = await prisma.message.findUnique({
          where: { id: messageId },
          select: { id: true, conversationId: true }
        }).catch(() => null);

        if (!message || message.conversationId !== `room_${roomId}`) {
          return safeAck(ack, { success: false, error: 'Message not found' });
        }

        if (data?.remove) {
          await prisma.messageReaction.deleteMany({
            where: { messageId, userId, emoji }
          });
        } else {
          await prisma.messageReaction.upsert({
            where: {
              messageId_userId_emoji: {
                messageId,
                userId,
                emoji
              }
            },
            update: {},
            create: {
              messageId,
              userId,
              emoji
            }
          });
        }

        const reactions = await prisma.messageReaction.groupBy({
          by: ['emoji'],
          where: { messageId },
          _count: { emoji: true }
        });

        const payload = {
          messageId,
          reactions: Object.fromEntries(reactions.map(item => [item.emoji, item._count.emoji])),
          serverTime: Date.now()
        };

        ns.to(roomId).emit('chat:reaction_updated', payload);

        await trackRoomEvent(roomId, 'chat_reaction', {
          userId,
          messageId,
          emoji,
          remove: !!data?.remove
        }).catch(() => null);

        safeAck(ack, { success: true, ...payload });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:typing', async (data: { isTyping: boolean }) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return;

        const isTyping = normalizeBoolean(data?.isTyping);

        if (isTyping) {
          await redisSafe(() => redis.setex(`room:${roomId}:typing:${userId}`, MAX_TYPING_TTL, '1'), 'OK');
        } else {
          await redisSafe(() => redis.del(`room:${roomId}:typing:${userId}`), 0);
        }

        socket.to(roomId).emit('chat:typing', {
          userId,
          isTyping,
          serverTime: Date.now()
        });
      } catch {}
    });

    socket.on('chat:pin', async (data: { messageId: string; pinned: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const allowed = await isRoomHostOrAdmin(roomId, userId, socket.data.role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Permission denied' });

        const messageId = normalizeString(data?.messageId, 128);
        if (!messageId) return safeAck(ack, { success: false, error: 'Message required' });

        await prisma.message.update({
          where: { id: messageId },
          data: { isPinned: normalizeBoolean(data?.pinned) } as any
        });

        ns.to(roomId).emit('chat:pin_updated', {
          messageId,
          pinned: normalizeBoolean(data?.pinned),
          updatedBy: userId,
          serverTime: Date.now()
        });

        await trackRoomEvent(roomId, 'chat_pin', {
          userId,
          messageId,
          pinned: normalizeBoolean(data?.pinned)
        }).catch(() => null);

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('gift:send', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        if (!(await rateLimitSocket(socket, 'gift_send', 20, 60))) {
          return safeAck(ack, { success: false, error: 'Too many gifts' });
        }

        const { toId, giftId, amount } = giftSchema.parse(data);

        if (!isValidId(toId)) return safeAck(ack, { success: false, error: 'Invalid recipient' });
        if (toId === userId) return safeAck(ack, { success: false, error: 'Cannot gift yourself' });

        const recipientInRoom = await isRoomMember(roomId, toId);
        if (!recipientInRoom) return safeAck(ack, { success: false, error: 'Recipient is not in room' });

        const hasBalance = await validateCoinBalance(userId, amount);
        if (!hasBalance) return safeAck(ack, { success: false, error: 'Insufficient coins' });

        const result = await processGift(userId, toId, roomId, giftId, amount);

        const fromUser = await getSafeUser(userId);
        const toUser = await getSafeUser(toId);

        const payload = {
          fromId: userId,
          toId,
          fromUser,
          toUser,
          giftId,
          amount,
          animation: result.animationType,
          combo: result.combo || null,
          serverTime: Date.now()
        };

        ns.to(roomId).emit('gift:trigger', payload);

        await trackRoomEvent(roomId, 'gift_sent', {
          fromId: userId,
          toId,
          giftId,
          amount
        }).catch(() => null);

        safeAck(ack, {
          success: true,
          newBalance: result.newBalance,
          payload
        });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('host:action', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const parsed = hostActionSchema.parse(data);
        const action = normalizeString(parsed.action, 50);
        const targetId = normalizeString(parsed.targetId, 128) || null;

        const allowed = await isRoomHostOrAdmin(roomId, userId, socket.data.role);

        if (!allowed && action !== 'raise_hand') {
          return safeAck(ack, { success: false, error: 'Permission denied' });
        }

        const payload: any = {
          action,
          targetId,
          executedBy: userId,
          roomId,
          serverTime: Date.now()
        };

        if (['mute', 'unmute', 'kick', 'promote_mod', 'remove_mod', 'transfer_host'].includes(action) && !targetId) {
          return safeAck(ack, { success: false, error: 'Target required' });
        }

        if (action === 'mute') {
          await prisma.seat.updateMany({
            where: { roomId, userId: targetId as string },
            data: { isMuted: true } as any
          });
          payload.isMuted = true;
        }

        if (action === 'unmute') {
          await prisma.seat.updateMany({
            where: { roomId, userId: targetId as string },
            data: { isMuted: false } as any
          });
          payload.isMuted = false;
        }

        if (action === 'kick') {
          await kickSocketFromRoom(ns, roomId, targetId as string, userId);
          payload.kicked = true;
        }

        if (action === 'promote_mod') {
          await prisma.seat.updateMany({
            where: { roomId, userId: targetId as string },
            data: { isModerator: true } as any
          });
          payload.isModerator = true;
        }

        if (action === 'remove_mod') {
          await prisma.seat.updateMany({
            where: { roomId, userId: targetId as string },
            data: { isModerator: false } as any
          });
          payload.isModerator = false;
        }

        if (action === 'lock_room') {
          await prisma.voiceRoom.update({
            where: { id: roomId },
            data: { isLocked: true } as any
          });
          payload.isLocked = true;
        }

        if (action === 'unlock_room') {
          await prisma.voiceRoom.update({
            where: { id: roomId },
            data: { isLocked: false } as any
          });
          payload.isLocked = false;
        }

        if (action === 'close_room') {
          await prisma.voiceRoom.update({
            where: { id: roomId },
            data: {
              isActive: false,
              endedAt: new Date(),
              status: 'ENDED'
            } as any
          }).catch(async () => {
            await prisma.voiceRoom.update({
              where: { id: roomId },
              data: {
                isActive: false,
                endedAt: new Date()
              } as any
            });
          });

          payload.closed = true;
          ns.to(roomId).emit('room:closed', payload);
        }

        if (action === 'transfer_host') {
          await prisma.$transaction([
            prisma.seat.updateMany({
              where: { roomId, userId },
              data: { isHost: false, isModerator: true } as any
            }),
            prisma.seat.updateMany({
              where: { roomId, userId: targetId as string },
              data: { isHost: true, isModerator: true } as any
            }),
            prisma.voiceRoom.update({
              where: { id: roomId },
              data: { hostId: targetId as string } as any
            })
          ]);
        }

        if (action === 'raise_hand') {
          await prisma.seat.updateMany({
            where: { roomId, userId },
            data: { handRaised: true } as any
          });
          payload.targetId = userId;
        }

        if (action === 'lower_hand') {
          const finalTarget = targetId || userId;

          await prisma.seat.updateMany({
            where: { roomId, userId: finalTarget },
            data: { handRaised: false } as any
          });

          payload.targetId = finalTarget;
        }

        if (action === 'launch_poll') {
          const poll = makePoll(roomId, userId, data);

          if (!poll) return safeAck(ack, { success: false, error: 'Invalid poll' });

          await cacheSet(`room:${roomId}:poll`, poll, ROOM_POLL_TTL);

          payload.poll = poll;

          ns.to(roomId).emit('poll:launched', poll);
        }

        const seats = await broadcastSeats(ns, roomId);

        payload.seats = seats;

        ns.to(roomId).emit('host:action_broadcast', payload);

        await trackRoomEvent(roomId, 'host_action', {
          action,
          userId,
          targetId
        }).catch(() => null);

        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, payload });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('poll:vote', async (data: { pollId: string; optionIndex: number }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const poll = await cacheGet<RoomPoll>(`room:${roomId}:poll`);

        if (!poll) return safeAck(ack, { success: false, error: 'Poll expired' });

        if (poll.id !== data?.pollId) return safeAck(ack, { success: false, error: 'Invalid poll' });

        const optionIndex = Number(data?.optionIndex);

        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
          return safeAck(ack, { success: false, error: 'Invalid option' });
        }

        if (poll.votes[userId] !== undefined) {
          return safeAck(ack, { success: false, error: 'Already voted' });
        }

        poll.votes[userId] = optionIndex;
        poll.options[optionIndex].count = Number(poll.options[optionIndex].count || 0) + 1;
        poll.totalVotes = Object.keys(poll.votes).length;

        await cacheSet(`room:${roomId}:poll`, poll, ROOM_POLL_TTL);

        ns.to(roomId).emit('poll:updated', poll);

        await trackRoomEvent(roomId, 'poll_vote', {
          userId,
          pollId: poll.id,
          optionIndex
        }).catch(() => null);

        safeAck(ack, { success: true, poll });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:invite', async (data: { targetId: string }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const targetId = normalizeString(data?.targetId, 128);

        if (!isValidId(targetId)) return safeAck(ack, { success: false, error: 'Target required' });

        const fromUser = await getSafeUser(userId);

        const room = await prisma.voiceRoom.findUnique({
          where: { id: roomId },
          select: {
            id: true,
            title: true,
            hostId: true
          } as any
        }).catch(() => null);

        ns.to(`user:${targetId}`).emit('room:invite', {
          room,
          fromUser,
          roomId,
          fromId: userId,
          createdAt: Date.now()
        });

        await trackRoomEvent(roomId, 'room_invite', {
          userId,
          targetId
        }).catch(() => null);

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:share', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        await trackRoomEvent(roomId, 'room_share', { userId }).catch(() => null);

        const baseUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL || '';

        safeAck(ack, {
          success: true,
          shareUrl: `${baseUrl}/voice/${roomId}`
        });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('disconnect', async reason => {
      try {
        const roomId = socket.data.currentRoom as string | null;

        if (roomId) {
          await leaveCurrentRoom(ns, socket, reason);
          await flushRoomAnalytics(roomId).catch(() => null);
        }

        socket.leave(`user:${userId}`);
      } catch {}
    });
  });

  if (!voiceIntervals.has(io)) {
    const analyticsTimer = setInterval(async () => {
      try {
        const stream = redis.scanStream({ match: 'room:*:analytics_buffer', count: 100 });

        stream.on('data', async (keys: string[]) => {
          for (const key of keys) {
            const parts = key.split(':');
            const roomId = parts[1];

            if (roomId) {
              await flushRoomAnalytics(roomId).catch(() => null);
            }
          }
        });
      } catch {}
    }, ANALYTICS_FLUSH_MS);

    analyticsTimer.unref?.();
    voiceIntervals.set(io, analyticsTimer);

    const shutdown = () => {
      const timer = voiceIntervals.get(io);

      if (timer) {
        clearInterval(timer);
        voiceIntervals.delete(io);
      }
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  return ns;
}

export async function emitVoiceRoomUpdated(io: Server, roomId: string) {
  const ns = io.of('/voice');
  const state = await getRoomState(roomId);

  await cacheSet(`room:${roomId}:state`, state, ROOM_STATE_TTL);

  ns.to(roomId).emit('room:sync', state);

  return state;
}

export async function emitVoiceRoomClosed(io: Server, roomId: string, reason = 'closed') {
  const ns = io.of('/voice');

  await prisma.voiceRoom.update({
    where: { id: roomId },
    data: {
      isActive: false,
      endedAt: new Date(),
      status: 'ENDED'
    } as any
  }).catch(async () => {
    await prisma.voiceRoom.update({
      where: { id: roomId },
      data: {
        isActive: false,
        endedAt: new Date()
      } as any
    }).catch(() => null);
  });

  ns.to(roomId).emit('room:closed', {
    roomId,
    reason,
    serverTime: Date.now()
  });

  await flushRoomAnalytics(roomId).catch(() => null);

  return true;
}

export async function emitVoiceGift(io: Server, roomId: string, payload: any) {
  const ns = io.of('/voice');

  ns.to(roomId).emit('gift:trigger', {
    ...payload,
    serverTime: Date.now()
  });

  return true;
}
