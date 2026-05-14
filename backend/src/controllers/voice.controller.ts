import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadFile } from '../utils/upload';
import { io } from '../app';

const ROOM_DEFAULT_LIMIT = 20;
const ROOM_MAX_LIMIT = 50;
const ROOM_TITLE_MAX = 120;
const ROOM_DESC_MAX = 1000;
const ROOM_MAX_SEATS = 50;

const cleanText = (value: unknown, max = 500) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.slice(0, max);
};

const parseBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const parseLimit = (value: unknown, fallback = ROOM_DEFAULT_LIMIT) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), ROOM_MAX_LIMIT);
};

const safeJson = <T = any>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

const normalizeRoomStatus = (value: unknown) => {
  const status = String(value || '').toLowerCase();
  if (['scheduled', 'live', 'ended', 'paused', 'cancelled'].includes(status)) return status;
  return 'live';
};

const normalizeVisibility = (value: unknown) => {
  const visibility = String(value || '').toLowerCase();
  if (['public', 'followers', 'private', 'invite_only'].includes(visibility)) return visibility;
  return 'public';
};

const normalizeSeatRole = (value: unknown) => {
  const role = String(value || '').toLowerCase();
  if (['host', 'cohost', 'speaker', 'listener', 'moderator'].includes(role)) return role;
  return 'listener';
};

const roomInclude = {
  host: {
    select: {
      id: true,
      username: true,
      fullName: true,
      isVerified: true,
      avatarUrl: true
    }
  },
  seats: {
    include: {
      user: {
        select: {
          id: true,
          username: true,
          fullName: true,
          isVerified: true,
          avatarUrl: true
        }
      }
    },
    orderBy: [
      { role: 'asc' as const },
      { joinedAt: 'asc' as const }
    ]
  },
  _count: {
    select: {
      seats: true
    }
  }
};

const canAccessRoom = async (room: any, userId?: string) => {
  if (!room) return false;
  if (room.hostId === userId) return true;
  if (room.status === 'ended' || room.status === 'cancelled') return false;
  if (room.visibility === 'private') return false;

  if (room.visibility === 'followers') {
    if (!userId) return false;
    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    });
    return Array.isArray(viewer?.following) && viewer.following.includes(room.hostId);
  }

  if (room.visibility === 'invite_only') {
    if (!userId) return false;
    const invited = Array.isArray(room.invitedUsers) ? room.invitedUsers : [];
    return invited.includes(userId);
  }

  return true;
};

const assertHostOrModerator = async (roomId: string, userId: string) => {
  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    include: {
      seats: {
        where: { userId },
        select: { role: true }
      }
    }
  });

  if (!room) return { room: null, allowed: false };

  const seatRole = room.seats?.[0]?.role;
  const allowed = room.hostId === userId || ['host', 'cohost', 'moderator'].includes(String(seatRole || '').toLowerCase());

  return { room, allowed };
};

const emitRoomSnapshot = async (roomId: string) => {
  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    include: roomInclude
  });

  if (room) {
    io.to(`room:${roomId}`).emit('room:update', room);
  }

  return room;
};

export const createRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const title = cleanText(req.body.title, ROOM_TITLE_MAX);
    const description = cleanText(req.body.description, ROOM_DESC_MAX);

    if (!title) {
      return res.status(400).json({
        error: 'Room title is required'
      });
    }

    const coverUrl = req.file ? await uploadFile(req.file, 'room_covers') : null;
    const visibility = normalizeVisibility(req.body.visibility);
    const status = normalizeRoomStatus(req.body.status);
    const maxSeats = Math.min(Math.max(Number(req.body.maxSeats || ROOM_MAX_SEATS), 1), ROOM_MAX_SEATS);
    const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;

    const room = await prisma.voiceRoom.create({
      data: {
        title,
        description,
        coverUrl,
        hostId: userId,
        status: scheduledFor ? 'scheduled' : status,
        visibility,
        maxSeats,
        topic: cleanText(req.body.topic, 80) || null,
        language: cleanText(req.body.language, 20) || 'en',
        tags: safeJson<string[]>(req.body.tags, []).map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 20),
        invitedUsers: safeJson<string[]>(req.body.invitedUsers, []),
        allowRecording: parseBool(req.body.allowRecording, false),
        allowListenersToSpeak: parseBool(req.body.allowListenersToSpeak, true),
        isRecorded: false,
        scheduledFor,
        startedAt: scheduledFor ? null : new Date(),
        seats: {
          create: {
            userId,
            role: 'host',
            isMuted: false,
            isSpeaker: true,
            joinedAt: new Date()
          }
        }
      } as any,
      include: roomInclude
    });

    io.to('rooms').emit('room:created', room);
    io.to(`user:${userId}`).emit('room:created', room);

    res.status(201).json(room);
  } catch {
    res.status(500).json({
      error: 'Failed to create room'
    });
  }
};

export const getRooms = async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const q = cleanText(req.query.q, 80);
    const topic = cleanText(req.query.topic, 80);
    const status = req.query.status ? normalizeRoomStatus(req.query.status) : 'live';
    const visibility = req.query.visibility ? normalizeVisibility(req.query.visibility) : undefined;

    const where: any = {
      status: status === 'ended' ? 'ended' : status
    };

    if (visibility) where.visibility = visibility;
    if (topic) where.topic = { equals: topic, mode: 'insensitive' };
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { topic: { contains: q, mode: 'insensitive' } },
        { tags: { has: q.toLowerCase() } }
      ];
    }

    const rooms = await prisma.voiceRoom.findMany({
      where,
      include: roomInclude,
      orderBy: [
        { startedAt: 'desc' },
        { createdAt: 'desc' }
      ],
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1
    });

    const hasMore = rooms.length > limit;
    const result = hasMore ? rooms.slice(0, -1) : rooms;

    res.json({
      rooms: result,
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch {
    res.status(500).json({
      error: 'Failed to fetch rooms'
    });
  }
};

export const getRoom = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const room = await prisma.voiceRoom.findUnique({
      where: { id },
      include: roomInclude
    });

    if (!room) {
      return res.status(404).json({
        error: 'Room not found'
      });
    }

    if (!(await canAccessRoom(room, userId))) {
      return res.status(403).json({
        error: 'Room unavailable'
      });
    }

    res.json({
      ...room,
      isHost: userId ? room.hostId === userId : false,
      mySeat: userId ? room.seats.find((seat: any) => seat.userId === userId) || null : null
    });
  } catch {
    res.status(500).json({
      error: 'Failed to fetch room'
    });
  }
};

export const joinRoom = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const room = await prisma.voiceRoom.findUnique({
      where: { id },
      include: {
        seats: true
      }
    });

    if (!room) {
      return res.status(404).json({
        error: 'Room not found'
      });
    }

    if (!(await canAccessRoom(room, userId))) {
      return res.status(403).json({
        error: 'You cannot join this room'
      });
    }

    if (room.status !== 'live' && room.status !== 'scheduled') {
      return res.status(400).json({
        error: 'Room is not live'
      });
    }

    const existingSeat = room.seats.find((seat: any) => seat.userId === userId);

    if (existingSeat) {
      return res.json({
        status: 'already_joined',
        seat: existingSeat
      });
    }

    const maxSeats = Number((room as any).maxSeats || ROOM_MAX_SEATS);

    if (room.seats.length >= maxSeats) {
      return res.status(400).json({
        error: 'Room is full'
      });
    }

    const role = room.hostId === userId ? 'host' : normalizeSeatRole(req.body.role);
    const speakerAllowed = room.hostId === userId || role === 'speaker' || role === 'cohost' || parseBool((room as any).allowListenersToSpeak, true);

    const seat = await prisma.seat.create({
      data: {
        roomId: id,
        userId,
        role,
        isMuted: role === 'listener',
        isSpeaker: speakerAllowed && role !== 'listener',
        joinedAt: new Date()
      } as any,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            isVerified: true,
            avatarUrl: true
          }
        }
      }
    });

    await prisma.voiceRoom.update({
      where: { id },
      data: {
        status: 'live',
        startedAt: (room as any).startedAt || new Date()
      } as any
    }).catch(() => null);

    io.to(`room:${id}`).emit('seat:joined', seat);
    io.to('rooms').emit('room:activity', {
      roomId: id,
      type: 'join',
      userId
    });

    const snapshot = await emitRoomSnapshot(id);

    res.status(201).json({
      status: 'joined',
      seat,
      room: snapshot
    });
  } catch {
    res.status(500).json({
      error: 'Failed to join room'
    });
  }
};

export const leaveRoom = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const room = await prisma.voiceRoom.findUnique({
      where: { id },
      include: {
        seats: true
      }
    });

    if (!room) {
      return res.status(404).json({
        error: 'Room not found'
      });
    }

    if (room.hostId === userId) {
      await prisma.voiceRoom.update({
        where: { id },
        data: {
          status: 'ended',
          endedAt: new Date()
        } as any
      });

      await prisma.seat.deleteMany({
        where: { roomId: id }
      });

      io.to(`room:${id}`).emit('room:closed', {
        roomId: id,
        reason: 'host_left'
      });

      io.to('rooms').emit('room:ended', {
        roomId: id
      });

      return res.json({
        status: 'room_closed'
      });
    }

    await prisma.seat.deleteMany({
      where: {
        roomId: id,
        userId
      }
    });

    io.to(`room:${id}`).emit('seat:left', {
      roomId: id,
      userId
    });

    const snapshot = await emitRoomSnapshot(id);

    res.json({
      status: 'left',
      room: snapshot
    });
  } catch {
    res.status(500).json({
      error: 'Failed to leave room'
    });
  }
};

export const roomControl = async (req: Request, res: Response) => {
  try {
    const roomId = String(req.body.roomId || req.params.id || '');
    const action = String(req.body.action || '').toLowerCase();
    const targetId = req.body.targetId ? String(req.body.targetId) : undefined;
    const userId = req.userId!;

    if (!roomId || !action) {
      return res.status(400).json({
        error: 'roomId and action are required'
      });
    }

    const { room, allowed } = await assertHostOrModerator(roomId, userId);

    if (!room || !allowed) {
      return res.status(403).json({
        error: 'Host/Admin only'
      });
    }

    if (['mute', 'unmute', 'speaker', 'listener', 'cohost', 'moderator', 'kick'].includes(action) && !targetId) {
      return res.status(400).json({
        error: 'targetId is required for this action'
      });
    }

    if (action === 'mute') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          isMuted: true
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:mute', {
        roomId,
        userId: targetId,
        muted: true
      });
    } else if (action === 'unmute') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          isMuted: false
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:mute', {
        roomId,
        userId: targetId,
        muted: false
      });
    } else if (action === 'speaker') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          role: 'speaker',
          isSpeaker: true,
          isMuted: false
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:role', {
        roomId,
        userId: targetId,
        role: 'speaker'
      });
    } else if (action === 'listener') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          role: 'listener',
          isSpeaker: false,
          isMuted: true
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:role', {
        roomId,
        userId: targetId,
        role: 'listener'
      });
    } else if (action === 'cohost') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          role: 'cohost',
          isSpeaker: true,
          isMuted: false
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:role', {
        roomId,
        userId: targetId,
        role: 'cohost'
      });
    } else if (action === 'moderator') {
      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },
        data: {
          role: 'moderator'
        } as any
      });

      io.to(`room:${roomId}`).emit('seat:role', {
        roomId,
        userId: targetId,
        role: 'moderator'
      });
    } else if (action === 'kick') {
      await prisma.seat.deleteMany({
        where: {
          roomId,
          userId: targetId
        }
      });

      io.to(`room:${roomId}`).emit('seat:kicked', {
        roomId,
        userId: targetId
      });

      io.to(`user:${targetId}`).emit('room:kicked', {
        roomId
      });
    } else if (action === 'pause') {
      await prisma.voiceRoom.update({
        where: { id: roomId },
        data: {
          status: 'paused'
        } as any
      });

      io.to(`room:${roomId}`).emit('room:paused', {
        roomId
      });
    } else if (action === 'resume') {
      await prisma.voiceRoom.update({
        where: { id: roomId },
        data: {
          status: 'live'
        } as any
      });

      io.to(`room:${roomId}`).emit('room:resumed', {
        roomId
      });
    } else if (action === 'close' || action === 'end') {
      await prisma.voiceRoom.update({
        where: { id: roomId },
        data: {
          status: 'ended',
          endedAt: new Date()
        } as any
      });

      await prisma.seat.deleteMany({
        where: { roomId }
      });

      io.to(`room:${roomId}`).emit('room:closed', {
        roomId,
        reason: 'host_closed'
      });

      io.to('rooms').emit('room:ended', {
        roomId
      });

      return res.json({
        status: 'executed',
        action
      });
    } else {
      return res.status(400).json({
        error: 'Invalid room action'
      });
    }

    const snapshot = await emitRoomSnapshot(roomId);

    res.json({
      status: 'executed',
      action,
      room: snapshot
    });
  } catch {
    res.status(500).json({
      error: 'Failed to control room'
    });
  }
};

export const updateRoom = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const room = await prisma.voiceRoom.findUnique({
      where: { id }
    });

    if (!room) {
      return res.status(404).json({
        error: 'Room not found'
      });
    }

    if (room.hostId !== userId) {
      return res.status(403).json({
        error: 'Host only'
      });
    }

    const data: any = {};

    const title = cleanText(req.body.title, ROOM_TITLE_MAX);
    const description = cleanText(req.body.description, ROOM_DESC_MAX);
    const topic = cleanText(req.body.topic, 80);
    const language = cleanText(req.body.language, 20);

    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (topic !== undefined) data.topic = topic;
    if (language !== undefined) data.language = language;
    if (req.body.visibility !== undefined) data.visibility = normalizeVisibility(req.body.visibility);
    if (req.body.tags !== undefined) data.tags = safeJson<string[]>(req.body.tags, []).map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 20);
    if (req.body.invitedUsers !== undefined) data.invitedUsers = safeJson<string[]>(req.body.invitedUsers, []);
    if (req.body.allowRecording !== undefined) data.allowRecording = parseBool(req.body.allowRecording);
    if (req.body.allowListenersToSpeak !== undefined) data.allowListenersToSpeak = parseBool(req.body.allowListenersToSpeak, true);

    if (req.file) {
      data.coverUrl = await uploadFile(req.file, 'room_covers');
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({
        error: 'No valid update fields provided'
      });
    }

    const updated = await prisma.voiceRoom.update({
      where: { id },
      data,
      include: roomInclude
    });

    io.to(`room:${id}`).emit('room:update', updated);
    io.to('rooms').emit('room:update', {
      roomId: id,
      updates: data
    });

    res.json(updated);
  } catch {
    res.status(500).json({
      error: 'Failed to update room'
    });
  }
};

export const requestToSpeak = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const room = await prisma.voiceRoom.findUnique({
      where: { id },
      select: {
        id: true,
        hostId: true,
        status: true
      }
    });

    if (!room) {
      return res.status(404).json({
        error: 'Room not found'
      });
    }

    const seat = await prisma.seat.findFirst({
      where: {
        roomId: id,
        userId
      }
    });

    if (!seat) {
      return res.status(400).json({
        error: 'Join room first'
      });
    }

    io.to(`user:${room.hostId}`).emit('room:speak_request', {
      roomId: id,
      userId,
      seatId: seat.id,
      timestamp: new Date()
    });

    io.to(`room:${id}`).emit('room:speak_request_public', {
      roomId: id,
      userId
    });

    res.json({
      status: 'requested'
    });
  } catch {
    res.status(500).json({
      error: 'Failed to request speaking access'
    });
  }
};

export const getMyActiveRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const room = await prisma.voiceRoom.findFirst({
      where: {
        OR: [
          { hostId: userId },
          { seats: { some: { userId } } }
        ],
        status: { in: ['live', 'scheduled', 'paused'] }
      } as any,
      include: roomInclude,
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      room
    });
  } catch {
    res.status(500).json({
      error: 'Failed to fetch active room'
    });
  }
};

export const getRoomParticipants = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const seats = await prisma.seat.findMany({
      where: { roomId: id },
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
        { role: 'asc' },
        { joinedAt: 'asc' }
      ] as any
    });

    res.json(seats);
  } catch {
    res.status(500).json({
      error: 'Failed to fetch room participants'
    });
  }
};
