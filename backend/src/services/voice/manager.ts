import { prisma } from '../../config/db';
import { redis, cache } from '../../config/redis';
import {
  trackRoomJoin,
  trackRoomLeave,
  trackRoomMessage,
  trackRoomReaction,
  trackRoomView,
  trackRoomEvent,
  flushRoomAnalytics,
  clearRoomAnalyticsBuffer
} from './analytics';
import { processGift, getRoomGiftStats, clearGiftRoomStats } from './economy';

export type RoomMusicTrack = {
  url: string;
  title: string;
  artist?: string;
  artworkUrl?: string;
  duration?: number;
  startedAt?: number;
  pausedAt?: number | null;
  isPlaying?: boolean;
};

export type RoomPollOption = {
  id: string;
  text: string;
  count: number;
};

export type RoomPollState = {
  id: string;
  question: string;
  options: RoomPollOption[];
  votes: Record<string, number>;
  createdAt: number;
  expiresAt: number;
};

export type RoomStateOptions = {
  includeChat?: boolean;
  includeMusic?: boolean;
  includePoll?: boolean;
  includePresence?: boolean;
  includeGiftStats?: boolean;
};

export type CreateRoomInput = {
  hostId: string;
  title: string;
  topic?: string;
  coverUrl?: string;
  category?: string;
  language?: string;
  tags?: string[];
  maxSeats?: number;
  isPrivate?: boolean;
  allowChat?: boolean;
  allowGifts?: boolean;
  allowRecording?: boolean;
};

export type UpdateRoomInput = Partial<{
  title: string;
  topic: string;
  coverUrl: string;
  category: string;
  language: string;
  tags: string[];
  maxSeats: number;
  isPrivate: boolean;
  allowChat: boolean;
  allowGifts: boolean;
  allowRecording: boolean;
  isLocked: boolean;
}>;

export type SafeUser = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  level?: string | number | null;
};

export type SendGiftInput = {
  fromId: string;
  toId: string;
  roomId: string;
  giftId: string;
  amount?: number;
};

const ROOM_STATE_TTL = Number(process.env.VOICE_ROOM_STATE_TTL || 15);
const ROOM_CACHE_TTL = Number(process.env.VOICE_ROOM_CACHE_TTL || 60);
const CHAT_LIMIT = Number(process.env.VOICE_ROOM_CHAT_LIMIT || 50);
const DEFAULT_MAX_SEATS = Number(process.env.VOICE_ROOM_DEFAULT_MAX_SEATS || 10);
const MAX_ROOM_SEATS = Number(process.env.VOICE_ROOM_MAX_SEATS || 50);
const MAX_TAGS = 12;
const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;
const USER_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;

function assertRoomId(roomId: string) {
  if (!roomId || typeof roomId !== 'string' || !ROOM_ID_REGEX.test(roomId)) {
    throw new Error('Invalid roomId');
  }
}

function assertUserId(userId: string, label = 'userId') {
  if (!userId || typeof userId !== 'string' || !USER_ID_REGEX.test(userId)) {
    throw new Error(`Invalid ${label}`);
  }
}

function cleanString(value: unknown, max = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanNullableString(value: unknown, max = 500) {
  const text = cleanString(value, max);
  return text || null;
}

function cleanTags(tags?: string[]) {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map(tag => cleanString(tag, 40).toLowerCase()).filter(Boolean))).slice(0, MAX_TAGS);
}

function cleanMaxSeats(value?: number) {
  const num = Number(value || DEFAULT_MAX_SEATS);
  if (!Number.isFinite(num)) return DEFAULT_MAX_SEATS;
  return Math.max(1, Math.min(MAX_ROOM_SEATS, Math.floor(num)));
}

function safeLimit(value: number, fallback: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(num)));
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function modelExists(model: string) {
  return Boolean((prisma as any)?.[model]);
}

function normalizeUpdateData(input: UpdateRoomInput) {
  const data: Record<string, any> = {};

  if (input.title !== undefined) data.title = cleanString(input.title, 120);
  if (input.topic !== undefined) data.topic = cleanNullableString(input.topic, 500);
  if (input.coverUrl !== undefined) data.coverUrl = cleanNullableString(input.coverUrl, 1000);
  if (input.category !== undefined) data.category = cleanNullableString(input.category, 80);
  if (input.language !== undefined) data.language = cleanString(input.language, 20) || 'en';
  if (input.tags !== undefined) data.tags = cleanTags(input.tags);
  if (input.maxSeats !== undefined) data.maxSeats = cleanMaxSeats(input.maxSeats);
  if (input.isPrivate !== undefined) data.isPrivate = Boolean(input.isPrivate);
  if (input.allowChat !== undefined) data.allowChat = Boolean(input.allowChat);
  if (input.allowGifts !== undefined) data.allowGifts = Boolean(input.allowGifts);
  if (input.allowRecording !== undefined) data.allowRecording = Boolean(input.allowRecording);
  if (input.isLocked !== undefined) data.isLocked = Boolean(input.isLocked);

  return data;
}

async function deleteCacheKeysByPattern(pattern: string) {
  const stream = redis.scanStream({ match: pattern, count: 100 });
  const keys: string[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string[]) => {
      for (const key of chunk) keys.push(key);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (keys.length) await redis.del(...keys);
}

export class RoomManager {
  static roomKey(roomId: string) {
    return `room:${roomId}`;
  }

  static roomStateKey(roomId: string) {
    return `room:${roomId}:state`;
  }

  static roomUsersKey(roomId: string) {
    return `room:${roomId}:users`;
  }

  static roomSeatsKey(roomId: string) {
    return `room:${roomId}:seats`;
  }

  static roomChatKey(roomId: string) {
    return `room:${roomId}:chat_buffer`;
  }

  static roomMusicKey(roomId: string) {
    return `room:${roomId}:music`;
  }

  static roomPollKey(roomId: string) {
    return `room:${roomId}:poll`;
  }

  static userRoomKey(userId: string) {
    return `user:${userId}:current_room`;
  }

  static kickedKey(roomId: string, userId: string) {
    return `room:${roomId}:kicked:${userId}`;
  }

  static presenceKey(roomId: string, userId: string) {
    return `room:${roomId}:presence:${userId}`;
  }

  static async createRoom(input: CreateRoomInput) {
    assertUserId(input.hostId, 'hostId');

    const title = cleanString(input.title, 120);
    if (!title) throw new Error('Room title is required');

    const room = await prisma.voiceRoom.create({
      data: {
        hostId: input.hostId,
        title,
        topic: cleanNullableString(input.topic, 500),
        coverUrl: cleanNullableString(input.coverUrl, 1000),
        category: cleanNullableString(input.category, 80),
        language: cleanString(input.language, 20) || 'en',
        tags: cleanTags(input.tags),
        maxSeats: cleanMaxSeats(input.maxSeats),
        isPrivate: Boolean(input.isPrivate),
        allowChat: input.allowChat ?? true,
        allowGifts: input.allowGifts ?? true,
        allowRecording: input.allowRecording ?? false,
        isActive: true,
        isLocked: false
      },
      include: {
        host: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      }
    });

    await this.takeSeat(room.id, input.hostId, { isHost: true, isMuted: false, seatIndex: 0 });
    await redis.sadd('voice:rooms:active', room.id);
    await redis.set(this.userRoomKey(input.hostId), room.id, 'EX', 86400);
    await this.invalidateRoom(room.id);
    await trackRoomEvent(room.id, 'room:create', { userId: input.hostId, title }).catch(() => null);

    return room;
  }

  static async getRoom(roomId: string) {
    assertRoomId(roomId);

    const cached = await cache.get<any>(this.roomKey(roomId));
    if (cached) return cached;

    const room = await prisma.voiceRoom.findUnique({
      where: { id: roomId },
      include: {
        host: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        },
        _count: {
          select: {
            seats: true
          }
        }
      }
    });

    if (room) await cache.set(this.roomKey(roomId), room, ROOM_CACHE_TTL);
    return room;
  }

  static async getRoomState(roomId: string, options: RoomStateOptions = {}) {
    assertRoomId(roomId);

    const cacheKey = `${this.roomStateKey(roomId)}:${Number(options.includeChat ?? true)}:${Number(options.includeMusic ?? true)}:${Number(options.includePoll ?? true)}:${Number(options.includePresence ?? true)}:${Number(options.includeGiftStats ?? true)}`;
    const cached = await cache.get<any>(cacheKey);
    if (cached) return cached;

    const includeChat = options.includeChat ?? true;
    const includeMusic = options.includeMusic ?? true;
    const includePoll = options.includePoll ?? true;
    const includePresence = options.includePresence ?? true;
    const includeGiftStats = options.includeGiftStats ?? true;

    const [room, seats, recentChat, music, poll, onlineCount, giftStats] = await Promise.all([
      this.getRoom(roomId),
      this.getSeats(roomId),
      includeChat ? this.getRecentChat(roomId) : Promise.resolve([]),
      includeMusic ? this.getRoomMusic(roomId) : Promise.resolve(null),
      includePoll ? this.getRoomPoll(roomId) : Promise.resolve(null),
      includePresence ? this.getOnlineCount(roomId) : Promise.resolve(0),
      includeGiftStats ? getRoomGiftStats(roomId).catch(() => null) : Promise.resolve(null)
    ]);

    const state = {
      room,
      seats,
      recentChat,
      music,
      poll,
      onlineCount,
      giftStats,
      isActive: Boolean(room?.isActive),
      isLocked: Boolean(room?.isLocked),
      maxSeats: room?.maxSeats || DEFAULT_MAX_SEATS,
      updatedAt: Date.now()
    };

    await cache.set(cacheKey, state, ROOM_STATE_TTL);
    return state;
  }

  static async updateRoom(roomId: string, hostId: string, input: UpdateRoomInput) {
    assertRoomId(roomId);
    assertUserId(hostId, 'hostId');

    const room = await prisma.voiceRoom.findFirst({
      where: {
        id: roomId,
        hostId
      }
    });

    if (!room) throw new Error('Room not found or permission denied');

    const data = normalizeUpdateData(input);
    if (data.title !== undefined && !data.title) throw new Error('Room title is required');

    const updated = await prisma.voiceRoom.update({
      where: { id: roomId },
      data,
      include: {
        host: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      }
    });

    await this.invalidateRoom(roomId);
    await trackRoomEvent(roomId, 'room:update', { userId: hostId, fields: Object.keys(data) }).catch(() => null);

    return updated;
  }

  static async closeRoom(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new Error('Room not found');
    if (room.hostId !== userId) throw new Error('Permission denied');

    const updated = await prisma.voiceRoom.update({
      where: { id: roomId },
      data: {
        isActive: false,
        isLocked: true,
        endedAt: new Date()
      }
    });

    const users = await redis.smembers(this.roomUsersKey(roomId));
    const uniqueUsers = Array.from(new Set(users.filter(Boolean)));

    if (uniqueUsers.length) {
      await prisma.$transaction(
        uniqueUsers.map(id =>
          prisma.user.updateMany({
            where: { id },
            data: { currentRoomId: null }
          })
        )
      );
    }

    await prisma.seat.deleteMany({ where: { roomId } });
    await Promise.all(uniqueUsers.map(id => redis.del(this.userRoomKey(id), this.presenceKey(roomId, id))));

    await Promise.all([
      flushRoomAnalytics(roomId).catch(() => null),
      redis.del(
        this.roomUsersKey(roomId),
        this.roomSeatsKey(roomId),
        this.roomStateKey(roomId),
        this.roomMusicKey(roomId),
        this.roomPollKey(roomId),
        this.roomChatKey(roomId)
      ),
      redis.srem('voice:rooms:active', roomId),
      clearGiftRoomStats(roomId).catch(() => null),
      clearRoomAnalyticsBuffer(roomId).catch(() => null),
      this.invalidateRoom(roomId),
      trackRoomEvent(roomId, 'room:close', { userId }).catch(() => null)
    ]);

    return updated;
  }

  static async getSeats(roomId: string) {
    assertRoomId(roomId);

    const cachedSeats = await redis.hgetall(this.roomSeatsKey(roomId));

    if (cachedSeats && Object.keys(cachedSeats).length > 0) {
      return Object.values(cachedSeats)
        .map(v => safeJsonParse<any | null>(v, null))
        .filter(Boolean)
        .sort((a, b) => {
          const ai = typeof a.seatIndex === 'number' ? a.seatIndex : 999;
          const bi = typeof b.seatIndex === 'number' ? b.seatIndex : 999;
          if (ai !== bi) return ai - bi;
          return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
        });
    }

    const seats = await prisma.seat.findMany({
      where: { roomId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      },
      orderBy: [
        { seatIndex: 'asc' },
        { createdAt: 'asc' }
      ]
    });

    if (seats.length) {
      const pipeline = redis.pipeline();
      for (const seat of seats) pipeline.hset(this.roomSeatsKey(roomId), seat.userId, JSON.stringify(seat));
      pipeline.expire(this.roomSeatsKey(roomId), ROOM_CACHE_TTL);
      await pipeline.exec();
    }

    return seats;
  }

  static async takeSeat(roomId: string, userId: string, options: Partial<{ isHost: boolean; isMuted: boolean; seatIndex: number }> = {}) {
    assertRoomId(roomId);
    assertUserId(userId);

    const room = await this.getRoom(roomId);
    if (!room || !room.isActive) throw new Error('Room not active');
    if (room.isLocked && !options.isHost) throw new Error('Room is locked');

    const kicked = await redis.exists(this.kickedKey(roomId, userId));
    if (kicked && !options.isHost) throw new Error('You were removed from this room');

    const existing = await prisma.seat.findFirst({
      where: { roomId, userId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      }
    });

    if (existing) {
      await redis.hset(this.roomSeatsKey(roomId), userId, JSON.stringify(existing));
      await redis.sadd(this.roomUsersKey(roomId), userId);
      await redis.set(this.userRoomKey(userId), roomId, 'EX', 86400);
      return existing;
    }

    const seats = await prisma.seat.findMany({
      where: { roomId },
      select: { seatIndex: true, userId: true }
    });

    const maxSeats = cleanMaxSeats(room.maxSeats || DEFAULT_MAX_SEATS);
    if (seats.length >= maxSeats) throw new Error('Room seats are full');

    const usedIndexes = new Set(seats.map(s => s.seatIndex).filter((v): v is number => typeof v === 'number'));
    let seatIndex = options.seatIndex;

    if (typeof seatIndex !== 'number' || seatIndex < 0 || seatIndex >= maxSeats || usedIndexes.has(seatIndex)) {
      seatIndex = 0;
      while (usedIndexes.has(seatIndex) && seatIndex < maxSeats) seatIndex++;
    }

    const seat = await prisma.seat.create({
      data: {
        roomId,
        userId,
        seatIndex,
        isHost: Boolean(options.isHost),
        isMuted: options.isMuted ?? false,
        isSpeaking: false,
        handRaised: false,
        isModerator: Boolean(options.isHost)
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      }
    });

    await Promise.all([
      redis.hset(this.roomSeatsKey(roomId), userId, JSON.stringify(seat)),
      redis.expire(this.roomSeatsKey(roomId), ROOM_CACHE_TTL),
      redis.sadd(this.roomUsersKey(roomId), userId),
      redis.expire(this.roomUsersKey(roomId), 86400),
      redis.set(this.userRoomKey(userId), roomId, 'EX', 86400),
      prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: roomId } }),
      this.invalidateRoomState(roomId),
      trackRoomEvent(roomId, 'room:seat:take', { userId, seatIndex, isHost: Boolean(options.isHost) }).catch(() => null)
    ]);

    return seat;
  }

  static async leaveSeat(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    await prisma.seat.deleteMany({ where: { roomId, userId } });

    await Promise.all([
      redis.hdel(this.roomSeatsKey(roomId), userId),
      redis.del(this.userRoomKey(userId)),
      prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: null } }),
      this.invalidateRoomState(roomId),
      trackRoomEvent(roomId, 'room:seat:leave', { userId }).catch(() => null)
    ]);

    return true;
  }

  static async joinRoom(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const permission = await this.canJoin(roomId, userId);
    if (!permission.allowed) throw new Error(permission.reason || 'Cannot join room');

    await Promise.all([
      redis.sadd(this.roomUsersKey(roomId), userId),
      redis.expire(this.roomUsersKey(roomId), 86400),
      redis.set(this.userRoomKey(userId), roomId, 'EX', 86400),
      redis.set(this.presenceKey(roomId, userId), Date.now().toString(), 'EX', 45),
      prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: roomId } }),
      this.invalidateRoomState(roomId),
      trackRoomJoin(roomId, userId).catch(() => null)
    ]);

    return this.getRoomState(roomId);
  }

  static async leaveRoom(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    await prisma.seat.deleteMany({ where: { roomId, userId } });

    await Promise.all([
      redis.hdel(this.roomSeatsKey(roomId), userId),
      redis.srem(this.roomUsersKey(roomId), userId),
      redis.del(this.userRoomKey(userId), this.presenceKey(roomId, userId)),
      prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: null } }),
      this.invalidateRoomState(roomId),
      trackRoomLeave(roomId, userId).catch(() => null)
    ]);

    return true;
  }

  static async getOnlineUsers(roomId: string) {
    assertRoomId(roomId);
    return redis.smembers(this.roomUsersKey(roomId));
  }

  static async getOnlineCount(roomId: string) {
    assertRoomId(roomId);
    return redis.scard(this.roomUsersKey(roomId));
  }

  static async isUserInRoom(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const exists = await redis.sismember(this.roomUsersKey(roomId), userId);
    if (exists) return true;

    const seat = await prisma.seat.findFirst({ where: { roomId, userId }, select: { id: true } });
    return Boolean(seat);
  }

  static async isUserSeated(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const cached = await redis.hget(this.roomSeatsKey(roomId), userId);
    if (cached) return true;

    const seat = await prisma.seat.findFirst({ where: { roomId, userId }, select: { id: true } });
    return Boolean(seat);
  }

  static async isHostOrModerator(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const seat = await prisma.seat.findFirst({
      where: { roomId, userId },
      select: { isHost: true, isModerator: true }
    });

    if (seat?.isHost || seat?.isModerator) return true;

    const room = await prisma.voiceRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true }
    });

    return room?.hostId === userId;
  }

  static async updateSeat(roomId: string, userId: string, data: Partial<{ isMuted: boolean; isSpeaking: boolean; handRaised: boolean; isModerator: boolean; isHost: boolean }>) {
    assertRoomId(roomId);
    assertUserId(userId);

    const cleanData: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'boolean') cleanData[key] = value;
    }

    const updated = await prisma.seat.updateMany({
      where: { roomId, userId },
      data: cleanData
    });

    const seat = await prisma.seat.findFirst({
      where: { roomId, userId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      }
    });

    if (seat) {
      await redis.hset(this.roomSeatsKey(roomId), userId, JSON.stringify(seat));
      await redis.expire(this.roomSeatsKey(roomId), ROOM_CACHE_TTL);
    }

    await Promise.all([
      this.invalidateRoomState(roomId),
      trackRoomEvent(roomId, 'room:seat:update', { userId, data: cleanData }).catch(() => null)
    ]);

    return { updated: updated.count, seat };
  }

  static async transferHost(roomId: string, currentHostId: string, targetUserId: string) {
    assertRoomId(roomId);
    assertUserId(currentHostId, 'currentHostId');
    assertUserId(targetUserId, 'targetUserId');

    const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
    if (!room) throw new Error('Room not found');
    if (room.hostId !== currentHostId) throw new Error('Only host can transfer ownership');

    const targetSeat = await prisma.seat.findFirst({ where: { roomId, userId: targetUserId } });
    if (!targetSeat) throw new Error('Target user is not seated');

    await prisma.$transaction([
      prisma.voiceRoom.update({ where: { id: roomId }, data: { hostId: targetUserId } }),
      prisma.seat.updateMany({ where: { roomId, userId: currentHostId }, data: { isHost: false } }),
      prisma.seat.updateMany({ where: { roomId, userId: targetUserId }, data: { isHost: true, isModerator: true, isMuted: false } })
    ]);

    await Promise.all([
      this.refreshSeatsCache(roomId),
      this.invalidateRoom(roomId),
      trackRoomEvent(roomId, 'room:host:transfer', { userId: currentHostId, targetUserId }).catch(() => null)
    ]);

    return this.getRoomState(roomId);
  }

  static async kickUser(roomId: string, actorId: string, targetUserId: string) {
    assertRoomId(roomId);
    assertUserId(actorId, 'actorId');
    assertUserId(targetUserId, 'targetUserId');

    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');
    if (actorId === targetUserId) throw new Error('Cannot kick yourself');

    const room = await prisma.voiceRoom.findUnique({
      where: { id: roomId },
      select: { hostId: true }
    });

    if (room?.hostId === targetUserId) throw new Error('Cannot kick room host');

    await this.leaveRoom(roomId, targetUserId);
    await redis.set(this.kickedKey(roomId, targetUserId), '1', 'EX', 3600);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:kick', { userId: actorId, targetUserId }).catch(() => null);

    return true;
  }

  static async canJoin(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    const [room, kicked] = await Promise.all([
      this.getRoom(roomId),
      redis.exists(this.kickedKey(roomId, userId))
    ]);

    if (!room || !room.isActive) return { allowed: false, reason: 'Room inactive' };
    if (room.isLocked) return { allowed: false, reason: 'Room locked' };
    if (kicked) return { allowed: false, reason: 'You were removed from this room' };

    return { allowed: true, reason: null };
  }

  static async pushChat(roomId: string, message: any) {
    assertRoomId(roomId);

    const room = await this.getRoom(roomId);
    if (!room?.allowChat) throw new Error('Chat is disabled');

    const payload = {
      ...message,
      roomId,
      id: message?.id || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      text: typeof message?.text === 'string' ? message.text.slice(0, 2000) : message?.text,
      createdAt: message?.createdAt || new Date().toISOString()
    };

    const key = this.roomChatKey(roomId);
    await redis.lpush(key, JSON.stringify(payload));
    await redis.ltrim(key, 0, CHAT_LIMIT - 1);
    await redis.expire(key, 86400);
    await this.invalidateRoomState(roomId);

    const userId = payload.userId || payload.senderId || payload.authorId;
    if (typeof userId === 'string') {
      await trackRoomMessage(roomId, userId, { messageId: payload.id }).catch(() => null);
    }

    return payload;
  }

  static async getRecentChat(roomId: string, limit = CHAT_LIMIT) {
    assertRoomId(roomId);

    const safe = safeLimit(limit, CHAT_LIMIT, 200);
    const rows = await redis.lrange(this.roomChatKey(roomId), 0, safe - 1);
    return rows.map(row => safeJsonParse<any | null>(row, null)).filter(Boolean).reverse();
  }

  static async clearChat(roomId: string, actorId: string) {
    assertRoomId(roomId);
    assertUserId(actorId, 'actorId');

    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');

    await redis.del(this.roomChatKey(roomId));
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:chat:clear', { userId: actorId }).catch(() => null);

    return true;
  }

  static async react(roomId: string, userId: string, reaction: string, meta: Record<string, any> = {}) {
    assertRoomId(roomId);
    assertUserId(userId);

    const cleanReaction = cleanString(reaction, 40);
    if (!cleanReaction) throw new Error('Invalid reaction');

    await trackRoomReaction(roomId, userId, { reaction: cleanReaction, ...meta }).catch(() => null);

    return {
      roomId,
      userId,
      reaction: cleanReaction,
      createdAt: Date.now()
    };
  }

  static async view(roomId: string, userId: string, meta: Record<string, any> = {}) {
    assertRoomId(roomId);
    assertUserId(userId);

    await trackRoomView(roomId, userId, meta).catch(() => null);

    return {
      roomId,
      userId,
      viewed: true
    };
  }

  static async sendGift(input: SendGiftInput) {
    assertRoomId(input.roomId);
    assertUserId(input.fromId, 'fromId');
    assertUserId(input.toId, 'toId');

    const room = await this.getRoom(input.roomId);
    if (!room || !room.isActive) throw new Error('Room not active');
    if (!room.allowGifts) throw new Error('Gifts are disabled');

    const result = await processGift(input.fromId, input.toId, input.roomId, input.giftId, input.amount);
    await this.invalidateRoomState(input.roomId);

    return {
      type: 'voice:gift',
      roomId: input.roomId,
      fromId: input.fromId,
      toId: input.toId,
      giftId: input.giftId,
      gift: result.gift,
      amount: result.amount,
      receiverAmount: result.receiverAmount,
      animationType: result.animationType,
      combo: result.combo,
      receiverRank: result.receiverRank,
      senderRank: result.senderRank,
      balance: result.newBalance,
      receiverBalance: result.receiverBalance,
      giftRecordId: result.giftRecordId
    };
  }

  static async setRoomMusic(roomId: string, track: RoomMusicTrack) {
    assertRoomId(roomId);

    const url = cleanString(track.url, 2000);
    const title = cleanString(track.title, 200);
    if (!url) throw new Error('Music URL is required');
    if (!title) throw new Error('Music title is required');

    const payload: RoomMusicTrack = {
      url,
      title,
      artist: cleanString(track.artist, 120),
      artworkUrl: cleanString(track.artworkUrl, 2000),
      duration: Math.max(0, Math.floor(Number(track.duration || 0))),
      startedAt: Date.now(),
      pausedAt: null,
      isPlaying: true
    };

    await cache.set(this.roomMusicKey(roomId), payload, 3600);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:music:set', { title: payload.title, artist: payload.artist }).catch(() => null);

    return payload;
  }

  static async getRoomMusic(roomId: string) {
    assertRoomId(roomId);
    return cache.get<RoomMusicTrack>(this.roomMusicKey(roomId));
  }

  static async pauseRoomMusic(roomId: string) {
    assertRoomId(roomId);

    const music = await this.getRoomMusic(roomId);
    if (!music) return null;

    const updated = {
      ...music,
      isPlaying: false,
      pausedAt: Date.now()
    };

    await cache.set(this.roomMusicKey(roomId), updated, 3600);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:music:pause', {}).catch(() => null);

    return updated;
  }

  static async resumeRoomMusic(roomId: string) {
    assertRoomId(roomId);

    const music = await this.getRoomMusic(roomId);
    if (!music) return null;

    const updated = {
      ...music,
      isPlaying: true,
      startedAt: Date.now(),
      pausedAt: null
    };

    await cache.set(this.roomMusicKey(roomId), updated, 3600);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:music:resume', {}).catch(() => null);

    return updated;
  }

  static async stopRoomMusic(roomId: string) {
    assertRoomId(roomId);

    await cache.delete(this.roomMusicKey(roomId)).catch(() => null);
    await redis.del(this.roomMusicKey(roomId));
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:music:stop', {}).catch(() => null);

    return true;
  }

  static async setRoomPoll(roomId: string, poll: any, ttl = 300) {
    assertRoomId(roomId);

    const question = cleanString(poll?.question, 300);
    if (!question) throw new Error('Poll question is required');

    const options = Array.isArray(poll?.options) ? poll.options : [];
    const normalizedOptions = options
      .map((option: any, index: number) => ({
        id: typeof option === 'object' && option?.id ? cleanString(option.id, 80) : `option_${index}`,
        text: cleanString(typeof option === 'string' ? option : option?.text, 160),
        count: Math.max(0, Math.floor(Number(option?.count || 0)))
      }))
      .filter((option: RoomPollOption) => option.text)
      .slice(0, 8);

    if (normalizedOptions.length < 2) throw new Error('Poll needs at least 2 options');

    const safeTtl = Math.max(30, Math.min(86400, Math.floor(Number(ttl) || 300)));

    const payload: RoomPollState = {
      id: cleanString(poll?.id, 100) || `poll_${Date.now()}`,
      question,
      options: normalizedOptions,
      votes: poll?.votes && typeof poll.votes === 'object' ? poll.votes : {},
      createdAt: Date.now(),
      expiresAt: Date.now() + safeTtl * 1000
    };

    await cache.set(this.roomPollKey(roomId), payload, safeTtl);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:poll:create', { pollId: payload.id }).catch(() => null);

    return payload;
  }

  static async getRoomPoll(roomId: string) {
    assertRoomId(roomId);
    return cache.get<RoomPollState>(this.roomPollKey(roomId));
  }

  static async votePoll(roomId: string, userId: string, optionIndex: number) {
    assertRoomId(roomId);
    assertUserId(userId);

    const poll = await this.getRoomPoll(roomId);
    if (!poll) throw new Error('Poll not found');
    if (poll.expiresAt <= Date.now()) throw new Error('Poll expired');
    if (poll.votes?.[userId] !== undefined) throw new Error('Already voted');

    const index = Math.floor(Number(optionIndex));
    if (!Number.isFinite(index) || !poll.options?.[index]) throw new Error('Invalid option');

    poll.votes[userId] = index;
    poll.options[index].count = Number(poll.options[index].count || 0) + 1;

    const ttl = Math.max(1, Math.floor((poll.expiresAt - Date.now()) / 1000));
    await cache.set(this.roomPollKey(roomId), poll, ttl);
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:poll:vote', { userId, pollId: poll.id, optionIndex: index }).catch(() => null);

    return poll;
  }

  static async endPoll(roomId: string, actorId: string) {
    assertRoomId(roomId);
    assertUserId(actorId, 'actorId');

    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');

    await cache.delete(this.roomPollKey(roomId)).catch(() => null);
    await redis.del(this.roomPollKey(roomId));
    await this.invalidateRoomState(roomId);
    await trackRoomEvent(roomId, 'room:poll:end', { userId: actorId }).catch(() => null);

    return true;
  }

  static async heartbeat(roomId: string, userId: string) {
    assertRoomId(roomId);
    assertUserId(userId);

    await Promise.all([
      redis.sadd(this.roomUsersKey(roomId), userId),
      redis.expire(this.roomUsersKey(roomId), 86400),
      redis.set(this.presenceKey(roomId, userId), Date.now().toString(), 'EX', 45),
      redis.set(this.userRoomKey(userId), roomId, 'EX', 86400)
    ]);

    return true;
  }

  static async getSafeUser(userId: string): Promise<SafeUser | null> {
    assertUserId(userId);

    const key = `user:${userId}:safe`;
    const cached = await cache.get<SafeUser>(key);
    if (cached) return cached;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        isVerified: true,
        level: true
      }
    });

    if (user) await cache.set(key, user, 300);
    return user;
  }

  static async refreshSeatsCache(roomId: string) {
    assertRoomId(roomId);

    await redis.del(this.roomSeatsKey(roomId));

    const seats = await prisma.seat.findMany({
      where: { roomId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        }
      },
      orderBy: [
        { seatIndex: 'asc' },
        { createdAt: 'asc' }
      ]
    });

    if (seats.length) {
      const pipeline = redis.pipeline();
      for (const seat of seats) pipeline.hset(this.roomSeatsKey(roomId), seat.userId, JSON.stringify(seat));
      pipeline.expire(this.roomSeatsKey(roomId), ROOM_CACHE_TTL);
      await pipeline.exec();
    }

    await this.invalidateRoomState(roomId);
    return seats;
  }

  static async getActiveRooms(limit = 30) {
    const safe = safeLimit(limit, 30, 100);
    const cacheKey = `voice:rooms:active:list:${safe}`;
    const cached = await cache.get<any[]>(cacheKey);
    if (cached) return cached;

    const rooms = await prisma.voiceRoom.findMany({
      where: {
        isActive: true,
        isPrivate: false
      },
      include: {
        host: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        },
        _count: {
          select: {
            seats: true
          }
        }
      },
      orderBy: [
        { updatedAt: 'desc' },
        { createdAt: 'desc' }
      ],
      take: safe
    });

    const enriched = await Promise.all(
      rooms.map(async room => ({
        ...room,
        onlineCount: await this.getOnlineCount(room.id)
      }))
    );

    await cache.set(cacheKey, enriched, 15);
    return enriched;
  }

  static async searchRooms(query: string, limit = 20) {
    const safe = safeLimit(limit, 20, 100);
    const q = cleanString(query, 100);

    if (!q) return this.getActiveRooms(safe);

    return prisma.voiceRoom.findMany({
      where: {
        isActive: true,
        isPrivate: false,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { topic: { contains: q, mode: 'insensitive' } },
          { category: { contains: q, mode: 'insensitive' } },
          { tags: { has: q.toLowerCase() } }
        ]
      },
      include: {
        host: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            level: true
          }
        },
        _count: {
          select: {
            seats: true
          }
        }
      },
      orderBy: {
        updatedAt: 'desc'
      },
      take: safe
    });
  }

  static async getUserCurrentRoom(userId: string) {
    assertUserId(userId);

    const cached = await redis.get(this.userRoomKey(userId));
    if (cached) return cached;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currentRoomId: true } as any
    }).catch(() => null);

    const roomId = (user as any)?.currentRoomId || null;
    if (roomId) await redis.set(this.userRoomKey(userId), roomId, 'EX', 86400);

    return roomId;
  }

  static async syncRoomPresence(roomId: string) {
    assertRoomId(roomId);

    const users = await redis.smembers(this.roomUsersKey(roomId));
    if (!users.length) return { roomId, removed: 0, online: 0 };

    const pipeline = redis.pipeline();
    const checks = await Promise.all(users.map(userId => redis.exists(this.presenceKey(roomId, userId))));
    let removed = 0;

    users.forEach((userId, index) => {
      if (!checks[index]) {
        pipeline.srem(this.roomUsersKey(roomId), userId);
        removed += 1;
      }
    });

    await pipeline.exec();
    await this.invalidateRoomState(roomId);

    return {
      roomId,
      removed,
      online: users.length - removed
    };
  }

  static async invalidateRoom(roomId: string) {
    assertRoomId(roomId);

    await Promise.all([
      redis.del(this.roomKey(roomId), this.roomStateKey(roomId)),
      cache.delete(this.roomKey(roomId)).catch(() => null),
      cache.delete(this.roomStateKey(roomId)).catch(() => null),
      deleteCacheKeysByPattern(`${this.roomStateKey(roomId)}:*`).catch(() => null),
      deleteCacheKeysByPattern('voice:rooms:active:list:*').catch(() => null)
    ]);
  }

  static async invalidateRoomState(roomId: string) {
    assertRoomId(roomId);

    await Promise.all([
      redis.del(this.roomStateKey(roomId)),
      cache.delete(this.roomStateKey(roomId)).catch(() => null),
      deleteCacheKeysByPattern(`${this.roomStateKey(roomId)}:*`).catch(() => null),
      deleteCacheKeysByPattern('voice:rooms:active:list:*').catch(() => null)
    ]);
  }
}
