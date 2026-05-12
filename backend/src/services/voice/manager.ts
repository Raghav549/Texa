import { prisma } from '../../config/db';
import { redis, cache } from '../../config/redis';

type RoomMusicTrack = {
  url: string;
  title: string;
  artist?: string;
  artworkUrl?: string;
  duration?: number;
  startedAt?: number;
  pausedAt?: number | null;
  isPlaying?: boolean;
};

type RoomStateOptions = {
  includeChat?: boolean;
  includeMusic?: boolean;
  includePoll?: boolean;
  includePresence?: boolean;
};

type CreateRoomInput = {
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

type UpdateRoomInput = Partial<{
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

type SafeUser = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  level?: string | number | null;
};

const ROOM_STATE_TTL = 15;
const ROOM_CACHE_TTL = 60;
const CHAT_LIMIT = 50;
const DEFAULT_MAX_SEATS = 10;

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

  static async createRoom(input: CreateRoomInput) {
    const room = await prisma.voiceRoom.create({
      data: {
        hostId: input.hostId,
        title: input.title.trim(),
        topic: input.topic?.trim() || null,
        coverUrl: input.coverUrl || null,
        category: input.category || null,
        language: input.language || 'en',
        tags: input.tags || [],
        maxSeats: input.maxSeats || DEFAULT_MAX_SEATS,
        isPrivate: input.isPrivate || false,
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

    await this.takeSeat(room.id, input.hostId, { isHost: true, isMuted: false });
    await redis.sadd('voice:rooms:active', room.id);
    await redis.set(this.userRoomKey(input.hostId), room.id, 'EX', 86400);
    await this.invalidateRoom(room.id);

    return room;
  }

  static async getRoom(roomId: string) {
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
    const cached = await cache.get<any>(this.roomStateKey(roomId));
    if (cached) return cached;

    const includeChat = options.includeChat ?? true;
    const includeMusic = options.includeMusic ?? true;
    const includePoll = options.includePoll ?? true;
    const includePresence = options.includePresence ?? true;

    const [room, seats, recentChat, music, poll, onlineCount] = await Promise.all([
      this.getRoom(roomId),
      this.getSeats(roomId),
      includeChat ? this.getRecentChat(roomId) : Promise.resolve([]),
      includeMusic ? this.getRoomMusic(roomId) : Promise.resolve(null),
      includePoll ? this.getRoomPoll(roomId) : Promise.resolve(null),
      includePresence ? this.getOnlineCount(roomId) : Promise.resolve(0)
    ]);

    const state = {
      room,
      seats,
      recentChat,
      music,
      poll,
      onlineCount,
      isActive: !!room?.isActive,
      isLocked: !!room?.isLocked,
      maxSeats: room?.maxSeats || DEFAULT_MAX_SEATS,
      updatedAt: Date.now()
    };

    await cache.set(this.roomStateKey(roomId), state, ROOM_STATE_TTL);
    return state;
  }

  static async updateRoom(roomId: string, hostId: string, input: UpdateRoomInput) {
    const room = await prisma.voiceRoom.findFirst({
      where: {
        id: roomId,
        hostId
      }
    });

    if (!room) throw new Error('Room not found or permission denied');

    const updated = await prisma.voiceRoom.update({
      where: { id: roomId },
      data: {
        title: input.title?.trim(),
        topic: input.topic?.trim(),
        coverUrl: input.coverUrl,
        category: input.category,
        language: input.language,
        tags: input.tags,
        maxSeats: input.maxSeats,
        isPrivate: input.isPrivate,
        allowChat: input.allowChat,
        allowGifts: input.allowGifts,
        allowRecording: input.allowRecording,
        isLocked: input.isLocked
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

    await this.invalidateRoom(roomId);
    return updated;
  }

  static async closeRoom(roomId: string, userId: string) {
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
    const tx = users.map(id => prisma.user.updateMany({ where: { id }, data: { currentRoomId: null } }));
    if (tx.length) await prisma.$transaction(tx);

    await prisma.seat.deleteMany({ where: { roomId } });
    await redis.del(
      this.roomUsersKey(roomId),
      this.roomSeatsKey(roomId),
      this.roomStateKey(roomId),
      this.roomMusicKey(roomId),
      this.roomPollKey(roomId),
      this.roomChatKey(roomId)
    );
    await redis.srem('voice:rooms:active', roomId);

    return updated;
  }

  static async getSeats(roomId: string) {
    const cachedSeats = await redis.hgetall(this.roomSeatsKey(roomId));

    if (cachedSeats && Object.keys(cachedSeats).length > 0) {
      return Object.values(cachedSeats)
        .map(v => JSON.parse(v))
        .sort((a, b) => {
          const ai = typeof a.seatIndex === 'number' ? a.seatIndex : 999;
          const bi = typeof b.seatIndex === 'number' ? b.seatIndex : 999;
          if (ai !== bi) return ai - bi;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
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
    const room = await this.getRoom(roomId);
    if (!room || !room.isActive) throw new Error('Room not active');
    if (room.isLocked && !options.isHost) throw new Error('Room is locked');

    const existing = await prisma.seat.findFirst({ where: { roomId, userId } });
    if (existing) return existing;

    const seats = await prisma.seat.findMany({
      where: { roomId },
      select: { seatIndex: true, userId: true }
    });

    const maxSeats = room.maxSeats || DEFAULT_MAX_SEATS;
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
        isHost: options.isHost || false,
        isMuted: options.isMuted ?? false,
        isSpeaking: false,
        handRaised: false,
        isModerator: options.isHost || false
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

    await redis.hset(this.roomSeatsKey(roomId), userId, JSON.stringify(seat));
    await redis.expire(this.roomSeatsKey(roomId), ROOM_CACHE_TTL);
    await redis.sadd(this.roomUsersKey(roomId), userId);
    await redis.expire(this.roomUsersKey(roomId), 86400);
    await redis.set(this.userRoomKey(userId), roomId, 'EX', 86400);
    await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: roomId } });
    await this.invalidateRoomState(roomId);

    return seat;
  }

  static async leaveSeat(roomId: string, userId: string) {
    await prisma.seat.deleteMany({ where: { roomId, userId } });
    await redis.hdel(this.roomSeatsKey(roomId), userId);
    await redis.del(this.userRoomKey(userId));
    await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: null } });
    await this.invalidateRoomState(roomId);
    return true;
  }

  static async joinRoom(roomId: string, userId: string) {
    const room = await this.getRoom(roomId);
    if (!room || !room.isActive) throw new Error('Room not found or inactive');
    if (room.isLocked) throw new Error('Room is locked');

    await redis.sadd(this.roomUsersKey(roomId), userId);
    await redis.expire(this.roomUsersKey(roomId), 86400);
    await redis.set(this.userRoomKey(userId), roomId, 'EX', 86400);
    await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: roomId } });
    await this.invalidateRoomState(roomId);

    return this.getRoomState(roomId);
  }

  static async leaveRoom(roomId: string, userId: string) {
    await this.leaveSeat(roomId, userId);
    await redis.srem(this.roomUsersKey(roomId), userId);
    await redis.del(this.userRoomKey(userId));
    await prisma.user.updateMany({ where: { id: userId }, data: { currentRoomId: null } });
    await this.invalidateRoomState(roomId);
    return true;
  }

  static async getOnlineUsers(roomId: string) {
    return redis.smembers(this.roomUsersKey(roomId));
  }

  static async getOnlineCount(roomId: string) {
    return redis.scard(this.roomUsersKey(roomId));
  }

  static async isUserInRoom(roomId: string, userId: string) {
    const exists = await redis.sismember(this.roomUsersKey(roomId), userId);
    if (exists) return true;

    const seat = await prisma.seat.findFirst({ where: { roomId, userId }, select: { id: true } });
    return !!seat;
  }

  static async isUserSeated(roomId: string, userId: string) {
    const cached = await redis.hget(this.roomSeatsKey(roomId), userId);
    if (cached) return true;

    const seat = await prisma.seat.findFirst({ where: { roomId, userId }, select: { id: true } });
    return !!seat;
  }

  static async isHostOrModerator(roomId: string, userId: string) {
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
    const updated = await prisma.seat.updateMany({
      where: { roomId, userId },
      data
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

    await this.invalidateRoomState(roomId);
    return { updated: updated.count, seat };
  }

  static async transferHost(roomId: string, currentHostId: string, targetUserId: string) {
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

    await this.refreshSeatsCache(roomId);
    await this.invalidateRoom(roomId);

    return this.getRoomState(roomId);
  }

  static async kickUser(roomId: string, actorId: string, targetUserId: string) {
    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');
    if (actorId === targetUserId) throw new Error('Cannot kick yourself');

    await this.leaveRoom(roomId, targetUserId);
    await redis.set(`room:${roomId}:kicked:${targetUserId}`, '1', 'EX', 3600);
    await this.invalidateRoomState(roomId);

    return true;
  }

  static async canJoin(roomId: string, userId: string) {
    const [room, kicked] = await Promise.all([
      this.getRoom(roomId),
      redis.exists(`room:${roomId}:kicked:${userId}`)
    ]);

    if (!room || !room.isActive) return { allowed: false, reason: 'Room inactive' };
    if (room.isLocked) return { allowed: false, reason: 'Room locked' };
    if (kicked) return { allowed: false, reason: 'You were removed from this room' };

    return { allowed: true, reason: null };
  }

  static async pushChat(roomId: string, message: any) {
    const key = this.roomChatKey(roomId);
    await redis.lpush(key, JSON.stringify(message));
    await redis.ltrim(key, 0, CHAT_LIMIT - 1);
    await redis.expire(key, 86400);
    await this.invalidateRoomState(roomId);
    return message;
  }

  static async getRecentChat(roomId: string, limit = CHAT_LIMIT) {
    const rows = await redis.lrange(this.roomChatKey(roomId), 0, limit - 1);
    return rows.map(row => JSON.parse(row)).reverse();
  }

  static async clearChat(roomId: string, actorId: string) {
    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');

    await redis.del(this.roomChatKey(roomId));
    await this.invalidateRoomState(roomId);
    return true;
  }

  static async setRoomMusic(roomId: string, track: RoomMusicTrack) {
    const payload: RoomMusicTrack = {
      url: track.url,
      title: track.title,
      artist: track.artist || '',
      artworkUrl: track.artworkUrl || '',
      duration: track.duration || 0,
      startedAt: Date.now(),
      pausedAt: null,
      isPlaying: true
    };

    await cache.set(this.roomMusicKey(roomId), payload, 3600);
    await this.invalidateRoomState(roomId);
    return payload;
  }

  static async getRoomMusic(roomId: string) {
    return cache.get<RoomMusicTrack>(this.roomMusicKey(roomId));
  }

  static async pauseRoomMusic(roomId: string) {
    const music = await this.getRoomMusic(roomId);
    if (!music) return null;

    const updated = {
      ...music,
      isPlaying: false,
      pausedAt: Date.now()
    };

    await cache.set(this.roomMusicKey(roomId), updated, 3600);
    await this.invalidateRoomState(roomId);
    return updated;
  }

  static async resumeRoomMusic(roomId: string) {
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
    return updated;
  }

  static async stopRoomMusic(roomId: string) {
    await redis.del(this.roomMusicKey(roomId));
    await this.invalidateRoomState(roomId);
    return true;
  }

  static async setRoomPoll(roomId: string, poll: any, ttl = 300) {
    const payload = {
      id: poll.id || `poll_${Date.now()}`,
      question: poll.question,
      options: (poll.options || []).map((option: any, index: number) => ({
        id: option.id || `option_${index}`,
        text: typeof option === 'string' ? option : option.text,
        count: option.count || 0
      })),
      votes: poll.votes || {},
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000
    };

    await cache.set(this.roomPollKey(roomId), payload, ttl);
    await this.invalidateRoomState(roomId);
    return payload;
  }

  static async getRoomPoll(roomId: string) {
    return cache.get<any>(this.roomPollKey(roomId));
  }

  static async votePoll(roomId: string, userId: string, optionIndex: number) {
    const poll = await this.getRoomPoll(roomId);
    if (!poll) throw new Error('Poll not found');
    if (poll.votes?.[userId] !== undefined) throw new Error('Already voted');
    if (!poll.options?.[optionIndex]) throw new Error('Invalid option');

    poll.votes[userId] = optionIndex;
    poll.options[optionIndex].count = (poll.options[optionIndex].count || 0) + 1;

    const ttl = Math.max(1, Math.floor((poll.expiresAt - Date.now()) / 1000));
    await cache.set(this.roomPollKey(roomId), poll, ttl);
    await this.invalidateRoomState(roomId);

    return poll;
  }

  static async endPoll(roomId: string, actorId: string) {
    const allowed = await this.isHostOrModerator(roomId, actorId);
    if (!allowed) throw new Error('Permission denied');

    await redis.del(this.roomPollKey(roomId));
    await this.invalidateRoomState(roomId);
    return true;
  }

  static async heartbeat(roomId: string, userId: string) {
    await redis.sadd(this.roomUsersKey(roomId), userId);
    await redis.expire(this.roomUsersKey(roomId), 86400);
    await redis.set(`room:${roomId}:presence:${userId}`, Date.now().toString(), 'EX', 45);
    await redis.set(this.userRoomKey(userId), roomId, 'EX', 86400);
    return true;
  }

  static async getSafeUser(userId: string): Promise<SafeUser | null> {
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
    const cached = await cache.get<any[]>(`voice:rooms:active:list:${limit}`);
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
      take: limit
    });

    const enriched = await Promise.all(
      rooms.map(async room => ({
        ...room,
        onlineCount: await this.getOnlineCount(room.id)
      }))
    );

    await cache.set(`voice:rooms:active:list:${limit}`, enriched, 15);
    return enriched;
  }

  static async searchRooms(query: string, limit = 20) {
    const q = query.trim();
    if (!q) return this.getActiveRooms(limit);

    return prisma.voiceRoom.findMany({
      where: {
        isActive: true,
        isPrivate: false,
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { topic: { contains: q, mode: 'insensitive' } },
          { category: { contains: q, mode: 'insensitive' } },
          { tags: { has: q } }
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
      take: limit
    });
  }

  static async invalidateRoom(roomId: string) {
    await redis.del(this.roomKey(roomId), this.roomStateKey(roomId));
    await cache.delete(`voice:rooms:active:list:30`);
  }

  static async invalidateRoomState(roomId: string) {
    await redis.del(this.roomStateKey(roomId));
  }
}
