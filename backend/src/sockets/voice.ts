import { Server, Socket } from 'socket.io';
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
};

type SafeUser = {
  id: string;
  username: string;
  avatarUrl: string | null;
  isVerified: boolean;
  level?: string | null;
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

function safeAck<T>(ack?: Ack<T>, response?: T) {
  if (typeof ack === 'function') ack(response);
}

function normalizeError(err: any) {
  if (err instanceof ZodError) return 'Invalid request data';
  if (err?.message) return err.message;
  return 'Something went wrong';
}

async function rateLimitSocket(socket: Socket, event: string, limit = SOCKET_RATE_LIMIT, windowSeconds = SOCKET_RATE_WINDOW) {
  const userId = socket.data.userId;
  const key = `voice:socket_rate:${userId}:${event}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}

async function getSafeUser(userId: string): Promise<SafeUser | null> {
  const cached = await cache.get<SafeUser>(`voice:user:${userId}`);
  if (cached) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, avatarUrl: true, isVerified: true, level: true }
  });

  if (user) await cache.set(`voice:user:${userId}`, user, 120);
  return user;
}

async function isRoomMember(roomId: string, userId: string) {
  const exists = await redis.sismember(`room:${roomId}:users`, userId);
  if (exists) return true;
  const seat = await prisma.seat.findFirst({ where: { roomId, userId }, select: { id: true } });
  return !!seat;
}

async function isRoomHostOrAdmin(roomId: string, userId: string, role?: string) {
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return true;
  const seat = await prisma.seat.findFirst({
    where: { roomId, userId },
    select: { isHost: true, isModerator: true }
  });
  return !!seat?.isHost || !!seat?.isModerator;
}

async function getOnlineCount(roomId: string) {
  return redis.scard(`room:${roomId}:users`);
}

async function syncRoom(ns: ReturnType<Server['of']>, roomId: string) {
  const state = await RoomManager.getRoomState(roomId);
  const onlineCount = await getOnlineCount(roomId);
  await cache.set(`room:${roomId}:state`, { ...state, onlineCount }, ROOM_STATE_TTL);
  ns.to(roomId).emit('room:sync', { ...state, onlineCount });
  return { ...state, onlineCount };
}

async function leaveCurrentRoom(ns: ReturnType<Server['of']>, socket: Socket, reason = 'leave') {
  const userId = socket.data.userId;
  const currentRoom = socket.data.currentRoom;

  if (!currentRoom) return;

  await RoomManager.leaveSeat(currentRoom, userId).catch(() => null);
  await redis.srem(`room:${currentRoom}:users`, userId);
  await redis.hdel(`room:${currentRoom}:presence`, userId);
  await redis.del(`room:${currentRoom}:typing:${userId}`);
  await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: null } }).catch(() => null);

  socket.leave(currentRoom);

  const user = await getSafeUser(userId);
  const onlineCount = await getOnlineCount(currentRoom);

  ns.to(currentRoom).emit('room:user_left', { userId, user, reason, onlineCount });
  ns.to(currentRoom).emit('presence:update', { userId, isOnline: false, roomId: currentRoom, onlineCount });

  await trackRoomEvent(currentRoom, 'leave', { userId, reason });
  await syncRoom(ns, currentRoom).catch(() => null);

  socket.data.currentRoom = null;
}

async function ensureConversationForRoom(roomId: string) {
  const conversationId = `room_${roomId}`;
  const existing = await prisma.conversation.findUnique({ where: { id: conversationId } }).catch(() => null);
  if (existing) return conversationId;

  await prisma.conversation.create({
    data: {
      id: conversationId,
      type: 'ROOM',
      title: `Voice Room ${roomId}`
    }
  }).catch(() => null);

  return conversationId;
}

export function initVoiceNamespace(io: Server) {
  const ns = io.of('/voice');

  ns.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, '');

      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; role?: string };

      if (!decoded?.userId) return next(new Error('Authentication required'));

      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role || 'USER';
      socket.data.currentRoom = null;
      socket.data.joinedAt = Date.now();

      socket.join(`user:${decoded.userId}`);

      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  ns.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;

    socket.emit('voice:connected', { userId, socketId: socket.id, serverTime: Date.now() });

    socket.on('room:join', async (data: { roomId: string }, ack?: Ack) => {
      try {
        if (!(await rateLimitSocket(socket, 'room_join', 20, 60))) return safeAck(ack, { success: false, error: 'Too many room joins' });

        const { roomId } = roomSchema.parse(data);
        const room = await RoomManager.getRoom(roomId);

        if (!room) return safeAck(ack, { success: false, error: 'Room not found or inactive' });

        if (socket.data.currentRoom && socket.data.currentRoom !== roomId) {
          await leaveCurrentRoom(ns, socket, 'switch_room');
        }

        const blocked = await prisma.blockedUser.findFirst({
          where: {
            OR: [
              { blockerId: room.hostId, blockedId: userId },
              { blockerId: userId, blockedId: room.hostId }
            ]
          },
          select: { id: true }
        }).catch(() => null);

        if (blocked) return safeAck(ack, { success: false, error: 'You cannot join this room' });

        socket.data.currentRoom = roomId;
        socket.join(roomId);

        await redis.sadd(`room:${roomId}:users`, userId);
        await redis.expire(`room:${roomId}:users`, ROOM_USER_TTL);
        await redis.hset(`room:${roomId}:presence`, userId, JSON.stringify({ userId, socketId: socket.id, joinedAt: Date.now(), lastSeen: Date.now() }));
        await redis.expire(`room:${roomId}:presence`, ROOM_USER_TTL);

        await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: roomId } }).catch(() => null);

        const user = await getSafeUser(userId);
        const state = await syncRoom(ns, roomId);

        ns.to(roomId).emit('room:user_joined', {
          userId,
          user,
          seat: state.seats?.find((seat: any) => seat.userId === userId) || null,
          onlineCount: state.onlineCount
        });

        ns.to(roomId).emit('presence:update', { userId, user, isOnline: true, roomId, onlineCount: state.onlineCount });

        await trackRoomEvent(roomId, 'join', { userId, socketId: socket.id });

        safeAck(ack, { success: true, roomId, state });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:leave', async (ack?: Ack) => {
      try {
        await leaveCurrentRoom(ns, socket);
        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:heartbeat', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        await redis.hset(`room:${roomId}:presence`, userId, JSON.stringify({ userId, socketId: socket.id, lastSeen: Date.now() }));
        await redis.expire(`room:${roomId}:presence`, ROOM_USER_TTL);

        safeAck(ack, { success: true, serverTime: Date.now() });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:state', async (data: { roomId?: string }, ack?: Ack) => {
      try {
        const roomId = data?.roomId || socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Room required' });

        const cached = await cache.get(`room:${roomId}:state`);
        if (cached) return safeAck(ack, { success: true, state: cached });

        const state = await syncRoom(ns, roomId);
        safeAck(ack, { success: true, state });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:take', async (data: { roomId?: string; seatIndex?: number }, ack?: Ack) => {
      try {
        if (!(await rateLimitSocket(socket, 'seat_take', 15, 60))) return safeAck(ack, { success: false, error: 'Too many seat actions' });

        const parsed = seatSchema.parse({ roomId: data?.roomId || socket.data.currentRoom, seatIndex: data?.seatIndex });
        const roomId = parsed.roomId;

        if (!roomId) return safeAck(ack, { success: false, error: 'Room required' });

        const room = await prisma.voiceRoom.findFirst({ where: { id: roomId, isActive: true } });
        if (!room) return safeAck(ack, { success: false, error: 'Invalid room' });

        const alreadySeated = await prisma.seat.findFirst({ where: { roomId, userId } });
        if (alreadySeated) return safeAck(ack, { success: true, seat: alreadySeated });

        const seatCount = await prisma.seat.count({ where: { roomId } });
        if (seatCount >= (room.maxSeats || MAX_SEATS)) return safeAck(ack, { success: false, error: 'Room full' });

        const isFirstSeat = seatCount === 0 || room.hostId === userId;

        const seat = await prisma.seat.create({
          data: {
            roomId,
            userId,
            seatIndex: typeof parsed.seatIndex === 'number' ? parsed.seatIndex : seatCount,
            isHost: isFirstSeat,
            isModerator: false,
            isMuted: false,
            isSpeaking: false,
            handRaised: false
          }
        });

        await redis.hset(`room:${roomId}:seats`, userId, JSON.stringify(seat));
        await redis.expire(`room:${roomId}:seats`, ROOM_USER_TTL);

        const user = await getSafeUser(userId);
        const seats = await RoomManager.getSeats(roomId);

        ns.to(roomId).emit('seats:update', { seats });
        ns.to(roomId).emit('seat:taken', { seat, user });

        await trackRoomEvent(roomId, 'seat_taken', { userId, seatId: seat.id, seatIndex: seat.seatIndex });
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, seat, seats });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:leave', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        await RoomManager.leaveSeat(roomId, userId);
        await redis.hdel(`room:${roomId}:seats`, userId);

        const seats = await RoomManager.getSeats(roomId);

        ns.to(roomId).emit('seats:update', { seats });
        ns.to(roomId).emit('seat:left', { userId });

        await trackRoomEvent(roomId, 'seat_left', { userId });
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, seats });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('seat:raise_hand', async (data: { raised?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const raised = data?.raised !== false;

        await prisma.seat.updateMany({ where: { roomId, userId }, data: { handRaised: raised } });

        ns.to(roomId).emit('seat:hand_update', { userId, handRaised: raised });

        await trackRoomEvent(roomId, raised ? 'hand_raised' : 'hand_lowered', { userId });

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('mic:toggle', async (data: { isMuted: boolean; isPushToTalk?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const seat = await prisma.seat.findFirst({ where: { roomId, userId } });
        if (!seat) return safeAck(ack, { success: false, error: 'Take a seat first' });

        await prisma.seat.updateMany({ where: { roomId, userId }, data: { isMuted: !!data.isMuted } });
        await redis.hset(`room:${roomId}:mic`, userId, JSON.stringify({ isMuted: !!data.isMuted, isPushToTalk: !!data.isPushToTalk, updatedAt: Date.now() }));

        ns.to(roomId).emit('mic:update', { userId, isMuted: !!data.isMuted, isPushToTalk: !!data.isPushToTalk });

        await trackRoomEvent(roomId, 'mic_toggle', { userId, isMuted: !!data.isMuted, isPushToTalk: !!data.isPushToTalk });

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('voice:activity', async (data: { isSpeaking: boolean; volume: number }) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return;

        if (!(await rateLimitSocket(socket, 'voice_activity', VOICE_ACTIVITY_RATE_LIMIT, VOICE_ACTIVITY_RATE_WINDOW))) return;

        const volume = Math.max(0, Math.min(100, Number(data.volume || 0)));
        const isSpeaking = !!data.isSpeaking;

        await redis.hset(`room:${roomId}:voice_activity`, userId, JSON.stringify({ isSpeaking, volume, updatedAt: Date.now() }));
        await redis.expire(`room:${roomId}:voice_activity`, 30);

        socket.to(roomId).emit('voice:activity', { userId, isSpeaking, volume });
      } catch {}
    });

    socket.on('voice:effect', async (data: { type: 'bass' | 'pitch' | 'robot' | 'clear' | 'studio' | 'echo' | 'cinema'; enabled: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const seat = await prisma.seat.findFirst({ where: { roomId, userId } });
        if (!seat) return safeAck(ack, { success: false, error: 'Take a seat first' });

        const allowed = ['bass', 'pitch', 'robot', 'clear', 'studio', 'echo', 'cinema'];
        if (!allowed.includes(data.type)) return safeAck(ack, { success: false, error: 'Invalid effect' });

        await redis.hset(`room:${roomId}:voice_effects`, userId, JSON.stringify({ type: data.type, enabled: !!data.enabled, updatedAt: Date.now() }));

        ns.to(roomId).emit('voice:effect', { userId, type: data.type, enabled: !!data.enabled });

        await trackRoomEvent(roomId, 'voice_effect', { userId, type: data.type, enabled: !!data.enabled });

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:send', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        if (!(await rateLimitSocket(socket, 'chat_send', 30, 30))) return safeAck(ack, { success: false, error: 'Slow down' });

        const validated = chatSchema.parse(data);
        const content = String(validated.content || '').trim();

        if (!content && !validated.mediaUrl) return safeAck(ack, { success: false, error: 'Message required' });
        if (content.length > MAX_CHAT_LENGTH) return safeAck(ack, { success: false, error: 'Message too long' });

        const member = await isRoomMember(roomId, userId);
        if (!member) return safeAck(ack, { success: false, error: 'Join room first' });

        const conversationId = await ensureConversationForRoom(roomId);

        const msg = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            content,
            mediaUrl: validated.mediaUrl || null,
            replyToId: validated.replyToId || null,
            status: 'DELIVERED',
            metadata: {
              source: 'voice_room',
              roomId,
              clientId: validated.clientId || null
            }
          },
          include: {
            sender: { select: { id: true, username: true, avatarUrl: true, isVerified: true } }
          }
        });

        await redis.lpush(`room:${roomId}:recent_messages`, JSON.stringify(msg));
        await redis.ltrim(`room:${roomId}:recent_messages`, 0, 49);
        await redis.expire(`room:${roomId}:recent_messages`, ROOM_USER_TTL);

        ns.to(roomId).emit('chat:new', { ...msg, timestamp: Date.now() });

        await trackRoomEvent(roomId, 'chat_message', { userId, messageId: msg.id, contentLength: content.length, hasMedia: !!validated.mediaUrl });

        safeAck(ack, { success: true, message: msg });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:reaction', async (data: { messageId: string; emoji: string; remove?: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        if (!data?.messageId || !data?.emoji) return safeAck(ack, { success: false, error: 'Invalid reaction' });

        if (data.remove) {
          await prisma.messageReaction.deleteMany({ where: { messageId: data.messageId, userId, emoji: data.emoji } });
        } else {
          await prisma.messageReaction.upsert({
            where: { messageId_userId_emoji: { messageId: data.messageId, userId, emoji: data.emoji } },
            update: {},
            create: { messageId: data.messageId, userId, emoji: data.emoji }
          });
        }

        const reactions = await prisma.messageReaction.groupBy({
          by: ['emoji'],
          where: { messageId: data.messageId },
          _count: { emoji: true }
        });

        const payload = {
          messageId: data.messageId,
          reactions: Object.fromEntries(reactions.map(r => [r.emoji, r._count.emoji]))
        };

        ns.to(roomId).emit('chat:reaction_updated', payload);

        await trackRoomEvent(roomId, 'chat_reaction', { userId, messageId: data.messageId, emoji: data.emoji, remove: !!data.remove });

        safeAck(ack, { success: true, ...payload });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('chat:typing', async (data: { isTyping: boolean }) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return;

        if (data?.isTyping) {
          await redis.setex(`room:${roomId}:typing:${userId}`, MAX_TYPING_TTL, '1');
        } else {
          await redis.del(`room:${roomId}:typing:${userId}`);
        }

        socket.to(roomId).emit('chat:typing', { userId, isTyping: !!data?.isTyping });
      } catch {}
    });

    socket.on('chat:pin', async (data: { messageId: string; pinned: boolean }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const allowed = await isRoomHostOrAdmin(roomId, userId, socket.data.role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Permission denied' });

        await prisma.message.update({
          where: { id: data.messageId },
          data: { isPinned: !!data.pinned }
        });

        ns.to(roomId).emit('chat:pin_updated', { messageId: data.messageId, pinned: !!data.pinned, updatedBy: userId });

        await trackRoomEvent(roomId, 'chat_pin', { userId, messageId: data.messageId, pinned: !!data.pinned });

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('gift:send', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        if (!(await rateLimitSocket(socket, 'gift_send', 20, 60))) return safeAck(ack, { success: false, error: 'Too many gifts' });

        const { toId, giftId, amount } = giftSchema.parse(data);

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

        await trackRoomEvent(roomId, 'gift_sent', { fromId: userId, toId, giftId, amount });

        safeAck(ack, { success: true, newBalance: result.newBalance, payload });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('host:action', async (data: any, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const parsed = hostActionSchema.parse(data);
        const { action, targetId } = parsed;

        const allowed = await isRoomHostOrAdmin(roomId, userId, socket.data.role);

        if (!allowed && action !== 'raise_hand') return safeAck(ack, { success: false, error: 'Permission denied' });

        let payload: any = { action, targetId: targetId || null, executedBy: userId, roomId };

        if (action === 'mute') {
          await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isMuted: true } });
          payload.isMuted = true;
        }

        if (action === 'unmute') {
          await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isMuted: false } });
          payload.isMuted = false;
        }

        if (action === 'kick') {
          await prisma.seat.deleteMany({ where: { roomId, userId: targetId } });
          await redis.srem(`room:${roomId}:users`, targetId);
          await redis.hdel(`room:${roomId}:seats`, targetId);
          ns.to(`user:${targetId}`).emit('room:kicked', { roomId, by: userId });
        }

        if (action === 'promote_mod') {
          await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isModerator: true } });
        }

        if (action === 'remove_mod') {
          await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isModerator: false } });
        }

        if (action === 'lock_room') {
          await prisma.voiceRoom.update({ where: { id: roomId }, data: { isLocked: true } });
          payload.isLocked = true;
        }

        if (action === 'unlock_room') {
          await prisma.voiceRoom.update({ where: { id: roomId }, data: { isLocked: false } });
          payload.isLocked = false;
        }

        if (action === 'close_room') {
          await prisma.voiceRoom.update({ where: { id: roomId }, data: { isActive: false, endedAt: new Date() } });
          payload.closed = true;
        }

        if (action === 'transfer_host') {
          if (!targetId) return safeAck(ack, { success: false, error: 'Target required' });

          await prisma.$transaction([
            prisma.seat.updateMany({ where: { roomId, userId }, data: { isHost: false, isModerator: true } }),
            prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isHost: true, isModerator: true } }),
            prisma.voiceRoom.update({ where: { id: roomId }, data: { hostId: targetId } })
          ]);
        }

        if (action === 'raise_hand') {
          await prisma.seat.updateMany({ where: { roomId, userId }, data: { handRaised: true } });
          payload.targetId = userId;
        }

        if (action === 'lower_hand') {
          await prisma.seat.updateMany({ where: { roomId, userId: targetId || userId }, data: { handRaised: false } });
          payload.targetId = targetId || userId;
        }

        if (action === 'launch_poll') {
          const poll = {
            id: `poll_${Date.now()}`,
            roomId,
            question: String(data.question || '').slice(0, 160),
            options: Array.isArray(data.options)
              ? data.options.slice(0, 6).map((option: any, index: number) => ({ id: String(index), text: String(option).slice(0, 80), count: 0 }))
              : [],
            votes: {},
            createdBy: userId,
            createdAt: Date.now(),
            expiresAt: Date.now() + ROOM_POLL_TTL * 1000
          };

          if (!poll.question || poll.options.length < 2) return safeAck(ack, { success: false, error: 'Invalid poll' });

          await cache.set(`room:${roomId}:poll`, poll, ROOM_POLL_TTL);
          payload.poll = poll;
          ns.to(roomId).emit('poll:launched', poll);
        }

        const seats = await RoomManager.getSeats(roomId).catch(() => []);
        payload.seats = seats;

        ns.to(roomId).emit('host:action_broadcast', payload);
        ns.to(roomId).emit('seats:update', { seats });

        await trackRoomEvent(roomId, 'host_action', { action, userId, targetId: targetId || null });
        await syncRoom(ns, roomId).catch(() => null);

        safeAck(ack, { success: true, payload });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('poll:vote', async (data: { pollId: string; optionIndex: number }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        const poll: any = await cache.get(`room:${roomId}:poll`);
        if (!poll) return safeAck(ack, { success: false, error: 'Poll expired' });
        if (poll.id !== data.pollId) return safeAck(ack, { success: false, error: 'Invalid poll' });

        const optionIndex = Number(data.optionIndex);
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
          return safeAck(ack, { success: false, error: 'Invalid option' });
        }

        if (poll.votes[userId] !== undefined) return safeAck(ack, { success: false, error: 'Already voted' });

        poll.votes[userId] = optionIndex;
        poll.options[optionIndex].count = Number(poll.options[optionIndex].count || 0) + 1;
        poll.totalVotes = Object.keys(poll.votes).length;

        await cache.set(`room:${roomId}:poll`, poll, ROOM_POLL_TTL);

        ns.to(roomId).emit('poll:updated', poll);

        await trackRoomEvent(roomId, 'poll_vote', { userId, pollId: poll.id, optionIndex });

        safeAck(ack, { success: true, poll });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:invite', async (data: { targetId: string }, ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });
        if (!data?.targetId) return safeAck(ack, { success: false, error: 'Target required' });

        const fromUser = await getSafeUser(userId);
        const room = await prisma.voiceRoom.findUnique({
          where: { id: roomId },
          select: { id: true, title: true, hostId: true }
        });

        ns.to(`user:${data.targetId}`).emit('room:invite', { room, fromUser, roomId, fromId: userId, createdAt: Date.now() });

        await trackRoomEvent(roomId, 'room_invite', { userId, targetId: data.targetId });

        safeAck(ack, { success: true });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('room:share', async (ack?: Ack) => {
      try {
        const roomId = socket.data.currentRoom;
        if (!roomId) return safeAck(ack, { success: false, error: 'Not in room' });

        await trackRoomEvent(roomId, 'room_share', { userId });

        safeAck(ack, { success: true, shareUrl: `${process.env.CLIENT_URL || ''}/voice/${roomId}` });
      } catch (err: any) {
        safeAck(ack, { success: false, error: normalizeError(err) });
      }
    });

    socket.on('disconnect', async reason => {
      try {
        const roomId = socket.data.currentRoom;

        if (roomId) {
          await leaveCurrentRoom(ns, socket, reason);
          await flushRoomAnalytics(roomId).catch(() => null);
        }

        socket.leave(`user:${userId}`);
      } catch {}
    });
  });

  const analyticsTimer = setInterval(async () => {
    try {
      const stream = redis.scanStream({ match: 'room:*:analytics_buffer', count: 100 });

      stream.on('data', async (keys: string[]) => {
        for (const key of keys) {
          const parts = key.split(':');
          const roomId = parts[1];
          if (roomId) await flushRoomAnalytics(roomId).catch(() => null);
        }
      });
    } catch {}
  }, 60000);

  analyticsTimer.unref?.();

  return ns;
}
