import { Request, Response } from "express";
import { NotificationType, RoomStatus, RoomVisibility, SeatRole } from "@prisma/client";
import { prisma } from "../config/db";
import { uploadFile } from "../utils/upload";
import { io } from "../app";

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const success = (res: Response, data: any, status = 200) => res.status(status).json({ success: true, ok: true, ...data });

const failure = (res: Response, status: number, error: string, extra: Record<string, any> = {}) =>
  res.status(status).json({ success: false, ok: false, error, ...extra });

const cleanText = (value: unknown, max = 500) => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};

const toBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
};

const toNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const lower = typeof min === "number" ? Math.max(n, min) : n;
  return typeof max === "number" ? Math.min(lower, max) : lower;
};

const parseJson = <T = any>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const normalizeTags = (value: unknown) => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().startsWith("[")
      ? parseJson<string[]>(value, [])
      : typeof value === "string"
        ? value.split(/[,\s]+/)
        : [];

  return Array.from(
    new Set(
      raw
        .map(item =>
          String(item)
            .replace(/^#/, "")
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_-]/gu, "")
        )
        .filter(Boolean)
    )
  ).slice(0, 20);
};

const getLimit = (value: unknown, fallback = DEFAULT_LIMIT) => Math.floor(toNumber(value, fallback, 1, MAX_LIMIT));

const normalizeVisibility = (value: unknown): RoomVisibility => {
  const text = String(value || "").trim().toUpperCase();
  if (text === "FOLLOWERS") return RoomVisibility.FOLLOWERS;
  if (text === "PRIVATE") return RoomVisibility.PRIVATE;
  return RoomVisibility.PUBLIC;
};

const normalizeSeatRole = (value: unknown): SeatRole => {
  const text = String(value || "").trim().toUpperCase();
  if (text === "HOST") return SeatRole.HOST;
  if (text === "COHOST") return SeatRole.COHOST;
  if (text === "MODERATOR") return SeatRole.MODERATOR;
  if (text === "LISTENER") return SeatRole.LISTENER;
  return SeatRole.SPEAKER;
};

const roomInclude = {
  host: {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      followers: true
    }
  },
  seats: {
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
    orderBy: [{ isHost: "desc" as const }, { isCoHost: "desc" as const }, { isModerator: "desc" as const }, { seatIndex: "asc" as const }, { joinedAt: "asc" as const }]
  },
  _count: {
    select: {
      seats: true,
      messages: true,
      gifts: true,
      polls: true
    }
  }
};

const getRoomWithAccess = async (roomId: string, userId?: string) => {
  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    include: roomInclude
  });

  if (!room) return { room: null, error: { status: 404, message: "Room not found" } };

  if (room.status !== RoomStatus.LIVE || !room.isActive) {
    if (room.hostId !== userId) return { room: null, error: { status: 403, message: "Room is not active" } };
  }

  if (room.visibility === RoomVisibility.PRIVATE && room.hostId !== userId) {
    const isMember = room.seats.some(seat => seat.userId === userId);
    if (!isMember) return { room: null, error: { status: 403, message: "Private room" } };
  }

  if (room.visibility === RoomVisibility.FOLLOWERS && room.hostId !== userId) {
    if (!userId) return { room: null, error: { status: 403, message: "Followers only room" } };

    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    });

    if (!viewer?.following?.includes(room.hostId)) {
      return { room: null, error: { status: 403, message: "Followers only room" } };
    }
  }

  return { room, error: null };
};

const getCurrentSeat = async (roomId: string, userId: string) => {
  return prisma.seat.findUnique({
    where: {
      roomId_userId: {
        roomId,
        userId
      }
    }
  });
};

const canModerate = async (roomId: string, userId: string) => {
  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    select: { hostId: true, status: true, isActive: true }
  });

  if (!room) return { allowed: false, room: null, role: null as SeatRole | null };
  if (room.hostId === userId) return { allowed: true, room, role: SeatRole.HOST };

  const seat = await getCurrentSeat(roomId, userId);

  if (!seat) return { allowed: false, room, role: null };

  const allowed = seat.role === SeatRole.HOST || seat.role === SeatRole.COHOST || seat.role === SeatRole.MODERATOR || seat.isHost || seat.isCoHost || seat.isModerator;

  return { allowed, room, role: seat.role };
};

const canHostOnly = async (roomId: string, userId: string) => {
  const room = await prisma.voiceRoom.findUnique({
    where: { id: roomId },
    select: { id: true, hostId: true, status: true, isActive: true }
  });

  return { allowed: !!room && room.hostId === userId, room };
};

const emitRoom = (roomId: string, event: string, payload: any) => {
  io.to(roomId).emit(event, payload);
  io.to(`room:${roomId}`).emit(event, payload);
};

const notifyUser = async (userId: string, type: NotificationType, title: string, body: string, data: any = {}) => {
  return prisma.notification
    .create({
      data: {
        userId,
        type,
        title,
        body,
        data,
        read: false
      }
    })
    .catch(() => null);
};

const logModeration = async (roomId: string, actorId: string, targetId: string | null, action: string, reason?: string) => {
  return prisma.voiceRoomModerationLog
    .create({
      data: {
        roomId,
        actorId,
        targetId,
        action,
        reason: reason || null
      }
    })
    .catch(() => null);
};

const getNextSeatIndex = async (roomId: string, maxSeats: number) => {
  const seats = await prisma.seat.findMany({
    where: { roomId, seatIndex: { not: null } },
    select: { seatIndex: true },
    orderBy: { seatIndex: "asc" }
  });

  const used = new Set(seats.map(seat => seat.seatIndex).filter((value): value is number => typeof value === "number"));

  for (let i = 0; i < maxSeats; i += 1) {
    if (!used.has(i)) return i;
  }

  return null;
};

export const createRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const title = cleanText(req.body.title, MAX_TITLE_LENGTH);
    const description = cleanText(req.body.description, MAX_DESCRIPTION_LENGTH);
    const category = cleanText(req.body.category, 80);
    const language = cleanText(req.body.language, 20) || "en";
    const visibility = normalizeVisibility(req.body.visibility);
    const maxSeats = Math.floor(toNumber(req.body.maxSeats, 10, 2, 50));
    const tags = normalizeTags(req.body.tags);
    const settings = parseJson(req.body.settings, {});
    const isLocked = toBool(req.body.isLocked, false);

    if (!title) return failure(res, 400, "Room title required");

    let coverUrl: string | undefined;

    if (req.file) {
      coverUrl = await uploadFile(req.file, "rooms");
    }

    const room = await prisma.$transaction(async tx => {
      const created = await tx.voiceRoom.create({
        data: {
          title,
          description: description || null,
          coverUrl,
          hostId: userId,
          visibility,
          status: RoomStatus.LIVE,
          isActive: true,
          isLocked,
          maxSeats,
          listenerCount: 1,
          peakListeners: 1,
          totalJoins: 1,
          category: category || null,
          language,
          tags,
          settings
        }
      });

      await tx.seat.create({
        data: {
          roomId: created.id,
          userId,
          role: SeatRole.HOST,
          seatIndex: 0,
          isHost: true,
          isCoHost: false,
          isModerator: true,
          isMuted: false,
          isSpeaking: false
        }
      });

      return tx.voiceRoom.findUnique({
        where: { id: created.id },
        include: roomInclude
      });
    });

    emitRoom(room!.id, "room:created", room);

    return success(res, { room }, 201);
  } catch (error: any) {
    return failure(res, 500, "Failed to create room", { code: error?.code || "CREATE_ROOM_FAILED" });
  }
};

export const getActiveRooms = async (req: Request, res: Response) => {
  try {
    const { cursor, limit = DEFAULT_LIMIT, category, language, search } = req.query;
    const take = getLimit(limit);
    const q = cleanText(search, 80);

    const rooms = await prisma.voiceRoom.findMany({
      where: {
        isActive: true,
        status: RoomStatus.LIVE,
        category: category ? String(category) : undefined,
        language: language ? String(language) : undefined,
        visibility: { not: RoomVisibility.PRIVATE },
        OR: q
          ? [
              { title: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { tags: { has: q.toLowerCase() } }
            ]
          : undefined
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
        },
        _count: {
          select: {
            seats: true,
            messages: true
          }
        }
      },
      cursor: cursor ? { id: String(cursor) } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: [{ listenerCount: "desc" }, { startedAt: "desc" }],
      take: take + 1
    });

    const hasMore = rooms.length > take;
    const result = hasMore ? rooms.slice(0, -1) : rooms;

    return success(res, {
      rooms: result,
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch {
    return failure(res, 500, "Failed to fetch rooms");
  }
};

export const getRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const { room, error } = await getRoomWithAccess(id, userId);

    if (error) return failure(res, error.status, error.message);

    const mySeat = userId ? await getCurrentSeat(id, userId) : null;

    return success(res, {
      room,
      mySeat,
      isHost: !!userId && room?.hostId === userId,
      canModerate: !!mySeat && (mySeat.isHost || mySeat.isCoHost || mySeat.isModerator || [SeatRole.HOST, SeatRole.COHOST, SeatRole.MODERATOR].includes(mySeat.role))
    });
  } catch {
    return failure(res, 500, "Failed to fetch room");
  }
};

export const joinRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const requestedRole = normalizeSeatRole(req.body.role);

    const { room, error } = await getRoomWithAccess(id, userId);

    if (error) return failure(res, error.status, error.message);
    if (!room) return failure(res, 404, "Room not found");
    if (room.isLocked && room.hostId !== userId) return failure(res, 403, "Room is locked");

    const existingSeat = await getCurrentSeat(id, userId);

    if (existingSeat) {
      const freshRoom = await prisma.voiceRoom.findUnique({ where: { id }, include: roomInclude });
      return success(res, { status: "already_joined", room: freshRoom, seat: existingSeat });
    }

    const role = room.hostId === userId ? SeatRole.HOST : requestedRole === SeatRole.LISTENER ? SeatRole.LISTENER : SeatRole.SPEAKER;
    const seatIndex = role === SeatRole.LISTENER ? null : await getNextSeatIndex(id, room.maxSeats);

    if (role !== SeatRole.LISTENER && seatIndex === null) return failure(res, 400, "No speaker seat available");

    const seat = await prisma.$transaction(async tx => {
      const createdSeat = await tx.seat.create({
        data: {
          roomId: id,
          userId,
          role,
          seatIndex,
          isHost: room.hostId === userId,
          isCoHost: false,
          isModerator: room.hostId === userId,
          isMuted: false,
          isSpeaking: false
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
        }
      });

      const count = await tx.seat.count({ where: { roomId: id } });

      await tx.voiceRoom.update({
        where: { id },
        data: {
          listenerCount: count,
          peakListeners: { increment: count > room.peakListeners ? count - room.peakListeners : 0 },
          totalJoins: { increment: 1 }
        }
      });

      return createdSeat;
    });

    emitRoom(id, "room:user_joined", { roomId: id, seat });

    const freshRoom = await prisma.voiceRoom.findUnique({ where: { id }, include: roomInclude });

    return success(res, { status: "joined", room: freshRoom, seat });
  } catch (error: any) {
    return failure(res, 500, "Failed to join room", { code: error?.code || "JOIN_ROOM_FAILED" });
  }
};

export const leaveRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;

    const room = await prisma.voiceRoom.findUnique({
      where: { id },
      select: { id: true, hostId: true, isActive: true, status: true }
    });

    if (!room) return failure(res, 404, "Room not found");

    if (room.hostId === userId) {
      await endRoomInternal(id, userId, "host_left");
      return success(res, { status: "ended" });
    }

    await prisma.$transaction(async tx => {
      await tx.seat.deleteMany({
        where: { roomId: id, userId }
      });

      const count = await tx.seat.count({ where: { roomId: id } });

      await tx.voiceRoom.update({
        where: { id },
        data: { listenerCount: count }
      });
    });

    emitRoom(id, "room:user_left", { roomId: id, userId });

    return success(res, { status: "left" });
  } catch {
    return failure(res, 500, "Failed to leave room");
  }
};

export const hostControl = async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.userId!;
    const action = cleanText(req.body.action, 40).toLowerCase();
    const targetUserId = cleanText(req.body.targetUserId, 80);
    const reason = cleanText(req.body.reason, 240);
    const seatRole = req.body.role ? normalizeSeatRole(req.body.role) : null;

    if (!action) return failure(res, 400, "Action required");

    const moderation = await canModerate(roomId, userId);

    if (!moderation.room) return failure(res, 404, "Room not found");
    if (!moderation.allowed) return failure(res, 403, "Host or moderator only");

    const hostOnlyActions = new Set(["end", "lock", "unlock", "promote", "demote", "transfer_host"]);

    if (hostOnlyActions.has(action)) {
      const hostCheck = await canHostOnly(roomId, userId);
      if (!hostCheck.allowed) return failure(res, 403, "Host only");
    }

    if (["mute", "unmute", "kick", "promote", "demote", "transfer_host"].includes(action) && !targetUserId) {
      return failure(res, 400, "Target user required");
    }

    if (targetUserId && targetUserId === userId && ["kick", "mute", "demote"].includes(action)) {
      return failure(res, 400, "Invalid self action");
    }

    if (action === "mute" || action === "unmute") {
      const muted = action === "mute";

      const result = await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetUserId
        },
        data: {
          isMuted: muted,
          isSpeaking: muted ? false : undefined
        }
      });

      if (!result.count) return failure(res, 404, "Target seat not found");

      await logModeration(roomId, userId, targetUserId, action, reason);

      emitRoom(roomId, "seat:mute", {
        roomId,
        userId: targetUserId,
        muted
      });

      await notifyUser(targetUserId, NotificationType.ROOM, muted ? "You were muted" : "You were unmuted", muted ? "A room moderator muted you" : "A room moderator unmuted you", { roomId });

      return success(res, { status: "executed", action, muted });
    }

    if (action === "kick") {
      const targetSeat = await getCurrentSeat(roomId, targetUserId);

      if (!targetSeat) return failure(res, 404, "Target seat not found");
      if (targetSeat.isHost || targetSeat.role === SeatRole.HOST) return failure(res, 400, "Cannot kick host");

      await prisma.$transaction(async tx => {
        await tx.seat.deleteMany({
          where: {
            roomId,
            userId: targetUserId
          }
        });

        const count = await tx.seat.count({ where: { roomId } });

        await tx.voiceRoom.update({
          where: { id: roomId },
          data: { listenerCount: count }
        });
      });

      await logModeration(roomId, userId, targetUserId, "kick", reason);

      emitRoom(roomId, "seat:kicked", {
        roomId,
        userId: targetUserId,
        reason: reason || null
      });

      await notifyUser(targetUserId, NotificationType.ROOM, "Removed from room", "You were removed from a voice room", { roomId, reason });

      return success(res, { status: "executed", action });
    }

    if (action === "lock" || action === "unlock") {
      const locked = action === "lock";

      const room = await prisma.voiceRoom.update({
        where: { id: roomId },
        data: { isLocked: locked },
        include: roomInclude
      });

      await logModeration(roomId, userId, null, action, reason);

      emitRoom(roomId, locked ? "room:locked" : "room:unlocked", {
        roomId,
        locked,
        room
      });

      return success(res, { status: "executed", action, room });
    }

    if (action === "end") {
      await endRoomInternal(roomId, userId, reason || "host_ended");
      return success(res, { status: "ended" });
    }

    if (action === "promote") {
      const role = seatRole && [SeatRole.COHOST, SeatRole.MODERATOR, SeatRole.SPEAKER].includes(seatRole) ? seatRole : SeatRole.MODERATOR;

      if (role === SeatRole.HOST) return failure(res, 400, "Use transfer_host action");

      const targetSeat = await getCurrentSeat(roomId, targetUserId);
      if (!targetSeat) return failure(res, 404, "Target seat not found");

      const updated = await prisma.seat.update({
        where: {
          roomId_userId: {
            roomId,
            userId: targetUserId
          }
        },
        data: {
          role,
          isCoHost: role === SeatRole.COHOST,
          isModerator: role === SeatRole.COHOST || role === SeatRole.MODERATOR
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
        }
      });

      await logModeration(roomId, userId, targetUserId, "promote", role);

      emitRoom(roomId, "seat:role_updated", {
        roomId,
        seat: updated
      });

      await notifyUser(targetUserId, NotificationType.ROOM, "Room role updated", `You are now ${role.toLowerCase()} in a room`, { roomId, role });

      return success(res, { status: "executed", action, seat: updated });
    }

    if (action === "demote") {
      const targetSeat = await getCurrentSeat(roomId, targetUserId);
      if (!targetSeat) return failure(res, 404, "Target seat not found");
      if (targetSeat.isHost || targetSeat.role === SeatRole.HOST) return failure(res, 400, "Cannot demote host");

      const updated = await prisma.seat.update({
        where: {
          roomId_userId: {
            roomId,
            userId: targetUserId
          }
        },
        data: {
          role: SeatRole.SPEAKER,
          isCoHost: false,
          isModerator: false
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
        }
      });

      await logModeration(roomId, userId, targetUserId, "demote", reason);

      emitRoom(roomId, "seat:role_updated", {
        roomId,
        seat: updated
      });

      return success(res, { status: "executed", action, seat: updated });
    }

    if (action === "transfer_host") {
      const targetSeat = await getCurrentSeat(roomId, targetUserId);
      if (!targetSeat) return failure(res, 404, "Target seat not found");

      await prisma.$transaction(async tx => {
        await tx.voiceRoom.update({
          where: { id: roomId },
          data: { hostId: targetUserId }
        });

        await tx.seat.updateMany({
          where: { roomId },
          data: {
            isHost: false
          }
        });

        await tx.seat.update({
          where: {
            roomId_userId: {
              roomId,
              userId: targetUserId
            }
          },
          data: {
            role: SeatRole.HOST,
            isHost: true,
            isCoHost: false,
            isModerator: true,
            seatIndex: targetSeat.seatIndex ?? 0
          }
        });

        await tx.seat.updateMany({
          where: {
            roomId,
            userId
          },
          data: {
            role: SeatRole.COHOST,
            isHost: false,
            isCoHost: true,
            isModerator: true
          }
        });
      });

      await logModeration(roomId, userId, targetUserId, "transfer_host", reason);

      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: roomInclude });

      emitRoom(roomId, "room:host_transferred", {
        roomId,
        oldHostId: userId,
        newHostId: targetUserId,
        room
      });

      await notifyUser(targetUserId, NotificationType.ROOM, "You are now host", "Room host control was transferred to you", { roomId });

      return success(res, { status: "executed", action, room });
    }

    return failure(res, 400, "Unsupported action");
  } catch (error: any) {
    return failure(res, 500, "Failed to execute host control", { code: error?.code || "HOST_CONTROL_FAILED" });
  }
};

export const updateSeat = async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.userId!;
    const action = cleanText(req.body.action, 40).toLowerCase();

    const seat = await getCurrentSeat(roomId, userId);

    if (!seat) return failure(res, 404, "Seat not found");

    if (action === "raise_hand" || action === "lower_hand") {
      const handRaised = action === "raise_hand";

      const updated = await prisma.seat.update({
        where: {
          roomId_userId: {
            roomId,
            userId
          }
        },
        data: { handRaised },
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
        }
      });

      emitRoom(roomId, "seat:hand_updated", {
        roomId,
        seat: updated
      });

      return success(res, { status: "updated", seat: updated });
    }

    if (action === "speaking_start" || action === "speaking_stop") {
      if (seat.isMuted) return failure(res, 403, "Seat is muted");

      const isSpeaking = action === "speaking_start";

      const updated = await prisma.seat.update({
        where: {
          roomId_userId: {
            roomId,
            userId
          }
        },
        data: { isSpeaking },
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
        }
      });

      emitRoom(roomId, "seat:speaking_updated", {
        roomId,
        seat: updated
      });

      return success(res, { status: "updated", seat: updated });
    }

    if (action === "audio_level") {
      const audioLevel = toNumber(req.body.audioLevel, 0, 0, 1);

      const updated = await prisma.seat.update({
        where: {
          roomId_userId: {
            roomId,
            userId
          }
        },
        data: { audioLevel },
        select: {
          roomId: true,
          userId: true,
          audioLevel: true,
          isSpeaking: true
        }
      });

      emitRoom(roomId, "seat:audio_level", updated);

      return success(res, { status: "updated" });
    }

    return failure(res, 400, "Unsupported seat action");
  } catch {
    return failure(res, 500, "Failed to update seat");
  }
};

export const updateRoom = async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.userId!;
    const hostCheck = await canHostOnly(roomId, userId);

    if (!hostCheck.room) return failure(res, 404, "Room not found");
    if (!hostCheck.allowed) return failure(res, 403, "Host only");

    const title = req.body.title !== undefined ? cleanText(req.body.title, MAX_TITLE_LENGTH) : undefined;
    const description = req.body.description !== undefined ? cleanText(req.body.description, MAX_DESCRIPTION_LENGTH) : undefined;
    const category = req.body.category !== undefined ? cleanText(req.body.category, 80) : undefined;
    const language = req.body.language !== undefined ? cleanText(req.body.language, 20) || "en" : undefined;
    const visibility = req.body.visibility !== undefined ? normalizeVisibility(req.body.visibility) : undefined;
    const maxSeats = req.body.maxSeats !== undefined ? Math.floor(toNumber(req.body.maxSeats, 10, 2, 50)) : undefined;
    const tags = req.body.tags !== undefined ? normalizeTags(req.body.tags) : undefined;
    const settings = req.body.settings !== undefined ? parseJson(req.body.settings, {}) : undefined;
    const isLocked = req.body.isLocked !== undefined ? toBool(req.body.isLocked) : undefined;

    if (title !== undefined && !title) return failure(res, 400, "Room title required");

    let coverUrl: string | undefined;

    if (req.file) {
      coverUrl = await uploadFile(req.file, "rooms");
    }

    const room = await prisma.voiceRoom.update({
      where: { id: roomId },
      data: {
        title,
        description,
        category,
        language,
        visibility,
        maxSeats,
        tags,
        settings,
        isLocked,
        coverUrl
      },
      include: roomInclude
    });

    emitRoom(roomId, "room:updated", room);

    return success(res, { room });
  } catch {
    return failure(res, 500, "Failed to update room");
  }
};

export const endRoom = async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.userId!;
    const reason = cleanText(req.body.reason, 240) || "host_ended";

    const hostCheck = await canHostOnly(roomId, userId);

    if (!hostCheck.room) return failure(res, 404, "Room not found");
    if (!hostCheck.allowed) return failure(res, 403, "Host only");

    await endRoomInternal(roomId, userId, reason);

    return success(res, { status: "ended" });
  } catch {
    return failure(res, 500, "Failed to end room");
  }
};

async function endRoomInternal(roomId: string, actorId: string, reason: string) {
  const room = await prisma.$transaction(async tx => {
    await tx.seat.deleteMany({
      where: { roomId }
    });

    const updated = await tx.voiceRoom.update({
      where: { id: roomId },
      data: {
        isActive: false,
        status: RoomStatus.ENDED,
        listenerCount: 0,
        endedAt: new Date()
      },
      include: roomInclude
    });

    return updated;
  });

  await logModeration(roomId, actorId, null, "end", reason);

  emitRoom(roomId, "room:ended", {
    roomId,
    reason,
    room
  });

  return room;
}

export const getRoomParticipants = async (req: Request, res: Response) => {
  try {
    const roomId = req.params.id;
    const userId = req.userId;

    const { room, error } = await getRoomWithAccess(roomId, userId);

    if (error) return failure(res, error.status, error.message);

    return success(res, {
      seats: room?.seats || [],
      count: room?.seats.length || 0
    });
  } catch {
    return failure(res, 500, "Failed to fetch room participants");
  }
};

export const getMyActiveRoom = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const seat = await prisma.seat.findFirst({
      where: {
        userId,
        room: {
          isActive: true,
          status: RoomStatus.LIVE
        }
      },
      include: {
        room: {
          include: roomInclude
        }
      },
      orderBy: { joinedAt: "desc" }
    });

    return success(res, {
      room: seat?.room || null,
      seat: seat || null
    });
  } catch {
    return failure(res, 500, "Failed to fetch active room");
  }
};
