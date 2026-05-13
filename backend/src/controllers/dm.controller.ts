import { Request, Response } from "express";
import { ConversationType, MediaType, MsgStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/db";
import { uploadToCloudinary } from "../utils/upload";
import { io } from "../app";
import { extractHashtags, extractMentions, generateLinkPreview } from "../utils/messageParser";
import { encryptMessage, decryptMessage } from "../utils/encryption";

const userSelect = {
  id: true,
  username: true,
  fullName: true,
  avatarUrl: true,
  isVerified: true
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_FORWARD_TARGETS = 25;
const MAX_GROUP_PARTICIPANTS = 250;
const MAX_MESSAGE_LENGTH = 10000;
const MAX_FOLDER_NAME_LENGTH = 60;

const ok = (res: Response, data: unknown, status = 200) => {
  return res.status(status).json(data);
};

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => {
  return res.status(status).json({
    success: false,
    ok: false,
    error,
    ...extra
  });
};

const safeNumber = (value: unknown, fallback: number, max = MAX_LIMIT) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const cleanString = (value: unknown, max = 1000) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
};

const parseDate = (value: unknown) => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeConversationType = (value: unknown): ConversationType => {
  const type = String(value || "DIRECT").trim().toUpperCase();
  if (type === "GROUP") return ConversationType.GROUP;
  if (type === "SUPPORT") return ConversationType.SUPPORT;
  if (type === "ROOM") return ConversationType.ROOM;
  return ConversationType.DIRECT;
};

const normalizeMediaType = (value: unknown): MediaType => {
  const type = String(value || "").trim().toUpperCase();
  if (type === "IMAGE") return MediaType.IMAGE;
  if (type === "VIDEO") return MediaType.VIDEO;
  if (type === "AUDIO" || type === "VOICE") return MediaType.AUDIO;
  if (type === "FILE") return MediaType.FILE;
  if (type === "GIF") return MediaType.GIF;
  return MediaType.NONE;
};

const normalizeParticipantIds = (creatorId: string, participantIds: unknown) => {
  if (!Array.isArray(participantIds)) return [];
  return [
    ...new Set(
      participantIds
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id && id !== creatorId)
    )
  ].slice(0, MAX_GROUP_PARTICIPANTS);
};

const normalizeStringArray = (value: unknown, max = 100) => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ].slice(0, max);
};

const getUserId = (req: Request) => {
  return (req as any).userId || (req as any).user?.id || "";
};

const isAdminParticipant = (role?: string | null) => {
  return ["admin", "owner", "moderator"].includes(String(role || "").toLowerCase());
};

const isParticipant = async (conversationId: string, userId: string) => {
  return prisma.conversationParticipant.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId
      }
    }
  });
};

const getConversationParticipantIds = async (conversationId: string) => {
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true }
  });
  return participants.map((p) => p.userId);
};

const emitToConversationUsers = async (conversationId: string, event: string, payload: unknown, excludeUserId?: string) => {
  const participantIds = await getConversationParticipantIds(conversationId);
  for (const id of participantIds) {
    if (id !== excludeUserId) io.to(`user:${id}`).emit(event, payload);
  }
  io.to(`dm:${conversationId}`).emit(event, payload);
  io.to(`conv:${conversationId}`).emit(event, payload);
};

const ensureConversationAccess = async (conversationId: string, userId: string, res: Response) => {
  if (!conversationId || !userId) {
    fail(res, 400, "Invalid conversation request");
    return null;
  }

  const participant = await isParticipant(conversationId, userId);

  if (!participant) {
    fail(res, 403, "Access denied");
    return null;
  }

  return participant;
};

const getDirectConversation = async (userA: string, userB: string) => {
  const conversations = await prisma.conversation.findMany({
    where: {
      type: ConversationType.DIRECT,
      participants: {
        some: { userId: userA }
      }
    },
    include: {
      participants: {
        select: { userId: true }
      }
    }
  });

  return (
    conversations.find((conversation) => {
      const ids = conversation.participants.map((p) => p.userId);
      return ids.length === 2 && ids.includes(userA) && ids.includes(userB);
    }) || null
  );
};

const getMessageInclude = {
  sender: {
    select: userSelect
  },
  replyTo: {
    include: {
      sender: {
        select: userSelect
      }
    }
  },
  forwardedFrom: {
    include: {
      sender: {
        select: userSelect
      }
    }
  }
};

const serializeMessage = async (message: any, viewerId?: string) => {
  const reactions = await prisma.messageReaction.groupBy({
    by: ["emoji"],
    where: { messageId: message.id },
    _count: { emoji: true }
  });

  const reactionMap = Object.fromEntries(reactions.map((r) => [r.emoji, r._count.emoji]));

  const reads = viewerId
    ? await prisma.messageRead.findMany({
        where: { messageId: message.id },
        select: { userId: true, readAt: true }
      })
    : [];

  return {
    ...message,
    reactionsSummary: reactionMap,
    reads
  };
};

const getMediaFolder = (mediaType: MediaType) => {
  if (mediaType === MediaType.AUDIO) return "voice_notes";
  if (mediaType === MediaType.VIDEO) return "dm_videos";
  if (mediaType === MediaType.FILE) return "dm_files";
  if (mediaType === MediaType.GIF) return "dm_gifs";
  return "dm_images";
};

const canMessageParticipants = async (senderId: string, participantIds: string[]) => {
  if (!participantIds.length) return true;

  const blocked = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        {
          blockerId: senderId,
          blockedId: { in: participantIds }
        },
        {
          blockerId: { in: participantIds },
          blockedId: senderId
        }
      ]
    },
    select: { id: true }
  });

  return !blocked;
};

const updateConversationLastMessage = async (conversationId: string, messageId: string) => {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageId: messageId,
      updatedAt: new Date()
    }
  });
};

export const createConversation = async (req: Request, res: Response) => {
  try {
    const creatorId = getUserId(req);
    const type = normalizeConversationType(req.body.type);
    const normalizedIds = normalizeParticipantIds(creatorId, req.body.participantIds);
    const name = cleanString(req.body.name, 120);
    const avatarUrl = cleanString(req.body.avatarUrl, 1000);

    if (!creatorId) return fail(res, 401, "Unauthorized");

    if (type === ConversationType.DIRECT) {
      if (normalizedIds.length !== 1) {
        return fail(res, 400, "Direct conversation requires exactly one participant");
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: normalizedIds[0] },
        select: { id: true, isBanned: true }
      });

      if (!targetUser || targetUser.isBanned) {
        return fail(res, 404, "User not available");
      }

      const allowed = await canMessageParticipants(creatorId, normalizedIds);

      if (!allowed) {
        return fail(res, 403, "Cannot create conversation with blocked user");
      }

      const existing = await getDirectConversation(creatorId, normalizedIds[0]);

      if (existing) {
        const fullExisting = await prisma.conversation.findUnique({
          where: { id: existing.id },
          include: {
            participants: {
              include: {
                user: {
                  select: userSelect
                }
              }
            },
            lastMessage: {
              include: {
                sender: {
                  select: userSelect
                }
              }
            }
          }
        });

        return ok(res, {
          success: true,
          ok: true,
          conversation: fullExisting
        });
      }
    }

    if (type === ConversationType.GROUP && normalizedIds.length < 1) {
      return fail(res, 400, "Group conversation requires participants");
    }

    if (type === ConversationType.GROUP && !name) {
      return fail(res, 400, "Group name is required");
    }

    const usersCount = await prisma.user.count({
      where: {
        id: { in: normalizedIds },
        isBanned: false
      }
    });

    if (usersCount !== normalizedIds.length) {
      return fail(res, 400, "One or more participants are invalid");
    }

    const conversation = await prisma.conversation.create({
      data: {
        type,
        name: type === ConversationType.GROUP ? name : null,
        avatarUrl: type === ConversationType.GROUP ? avatarUrl || null : null,
        participants: {
          create: [
            { userId: creatorId, role: type === ConversationType.GROUP ? "admin" : "member" },
            ...normalizedIds.map((userId: string) => ({ userId, role: "member" }))
          ]
        }
      },
      include: {
        participants: {
          include: {
            user: {
              select: userSelect
            }
          }
        },
        lastMessage: true
      }
    });

    for (const participant of conversation.participants) {
      io.to(`user:${participant.userId}`).emit("conversation:new", conversation);
    }

    return ok(
      res,
      {
        success: true,
        ok: true,
        conversation
      },
      201
    );
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to create conversation");
  }
};

export const getConversations = async (req: Request, res: Response) => {
  try {
    const limit = safeNumber(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const includeArchived = req.query.includeArchived === "true";
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const conversations = await prisma.conversation.findMany({
      where: {
        participants: {
          some: {
            userId,
            ...(includeArchived ? {} : { isArchived: false })
          }
        }
      },
      include: {
        lastMessage: {
          include: {
            sender: {
              select: userSelect
            }
          }
        },
        participants: {
          include: {
            user: {
              select: userSelect
            }
          }
        }
      },
      orderBy: { updatedAt: "desc" },
      take: limit
    });

    const result = await Promise.all(
      conversations.map(async (conversation) => {
        const viewer = conversation.participants.find((p) => p.userId === userId);

        const unreadCount = await prisma.message.count({
          where: {
            conversationId: conversation.id,
            senderId: { not: userId },
            deletedAt: null,
            deletedFor: { not: { has: userId } },
            ...(viewer?.lastReadAt ? { createdAt: { gt: viewer.lastReadAt } } : {})
          }
        });

        return {
          ...conversation,
          unreadCount,
          viewerParticipant: viewer || null
        };
      })
    );

    return ok(res, {
      success: true,
      ok: true,
      conversations: result
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to load conversations");
  }
};

export const getConversation = async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id || req.params.conversationId;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: {
              select: userSelect
            }
          }
        },
        pinnedMessages: {
          include: {
            message: {
              include: {
                sender: {
                  select: userSelect
                }
              }
            }
          },
          orderBy: { pinnedAt: "desc" }
        },
        lastMessage: {
          include: {
            sender: {
              select: userSelect
            }
          }
        },
        drafts: {
          where: { userId },
          take: 1
        }
      }
    });

    if (!conversation) return fail(res, 404, "Conversation not found");

    await prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      data: {
        lastReadAt: new Date()
      }
    });

    return ok(res, {
      success: true,
      ok: true,
      conversation
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to load conversation");
  }
};

export const sendMessage = async (req: Request, res: Response) => {
  try {
    const senderId = getUserId(req);
    const conversationId = cleanString(req.body.conversationId, 200);
    const rawContent = typeof req.body.content === "string" ? req.body.content.slice(0, MAX_MESSAGE_LENGTH) : "";
    const content = rawContent.trim() ? rawContent : null;
    const replyToId = cleanString(req.body.replyToId, 200) || null;
    const scheduledFor = parseDate(req.body.scheduledFor);
    const expiresAt = parseDate(req.body.expiresAt);
    const poll = req.body.poll && typeof req.body.poll === "object" ? req.body.poll : undefined;
    const payment = req.body.payment && typeof req.body.payment === "object" ? req.body.payment : undefined;
    const media = req.body.media && typeof req.body.media === "object" ? req.body.media : null;
    const isEncrypted = Boolean(req.body.isEncrypted);

    if (!senderId) return fail(res, 401, "Unauthorized");
    if (!conversationId) return fail(res, 400, "conversationId is required");

    const participant = await ensureConversationAccess(conversationId, senderId, res);
    if (!participant) return;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          select: { userId: true }
        }
      }
    });

    if (!conversation) return fail(res, 404, "Conversation not found");

    const otherParticipantIds = conversation.participants.map((p) => p.userId).filter((id) => id !== senderId);
    const allowed = await canMessageParticipants(senderId, otherParticipantIds);

    if (!allowed) return fail(res, 403, "Cannot message blocked user");

    if (replyToId) {
      const reply = await prisma.message.findFirst({
        where: {
          id: replyToId,
          conversationId,
          deletedAt: null
        },
        select: { id: true }
      });

      if (!reply) return fail(res, 404, "Reply message not found");
    }

    if (!content && !req.file && !media?.url && !poll && !payment) {
      return fail(res, 400, "Message cannot be empty");
    }

    const hashtags = extractHashtags(content || "");
    const mentions = extractMentions(content || "");
    const linkPreviews = content ? await generateLinkPreview(content) : [];

    let finalContent = content;
    let encryptionData: Prisma.InputJsonValue | undefined;

    if (isEncrypted && content) {
      const encryptedPayload = await encryptMessage(content, senderId);
      finalContent = encryptedPayload.encrypted;
      encryptionData = {
        algorithm: "AES-GCM",
        keyId: encryptedPayload.keyId,
        iv: encryptedPayload.iv
      };
    }

    const mediaType = normalizeMediaType(media?.type || (req.file as any)?.mimetype?.split("/")?.[0]);
    let mediaUrl: string | null = typeof media?.url === "string" ? media.url.trim() || null : null;

    if (req.file) {
      mediaUrl = await uploadToCloudinary(req.file, getMediaFolder(mediaType));
    }

    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId,
        receiverId: conversation.type === ConversationType.DIRECT ? otherParticipantIds[0] || null : null,
        content: finalContent,
        mediaUrl,
        mediaType,
        replyToId,
        hashtags,
        mentions,
        linkPreviews: linkPreviews as Prisma.InputJsonValue,
        poll: poll as Prisma.InputJsonValue,
        payment: payment as Prisma.InputJsonValue,
        encryption: encryptionData,
        scheduledFor,
        expiresAt,
        isScheduled: Boolean(scheduledFor),
        status: scheduledFor ? MsgStatus.SENT : MsgStatus.DELIVERED
      },
      include: getMessageInclude
    });

    await updateConversationLastMessage(conversationId, message.id);

    await prisma.draftMessage.deleteMany({
      where: {
        conversationId,
        userId: senderId
      }
    });

    const payload = await serializeMessage(message, senderId);

    await emitToConversationUsers(conversationId, "message:new", payload, senderId);
    io.to(`user:${senderId}`).emit("message:sent", payload);

    return ok(
      res,
      {
        success: true,
        ok: true,
        message: payload
      },
      201
    );
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to send message");
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const userId = getUserId(req);
    const limit = safeNumber(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const before = parseDate(req.query.before);
    const after = parseDate(req.query.after);
    const search = cleanString(req.query.search, 200);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!conversationId) return fail(res, 400, "conversationId is required");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const where: Prisma.MessageWhereInput = {
      conversationId,
      deletedAt: null,
      deletedFor: { not: { has: userId } }
    };

    if (before || after) {
      where.createdAt = {
        ...(before ? { lt: before } : {}),
        ...(after ? { gt: after } : {})
      };
    }

    if (search) {
      where.OR = [
        { content: { contains: search, mode: "insensitive" } },
        { hashtags: { has: search } },
        { mentions: { has: search } }
      ];
    }

    const messages = await prisma.message.findMany({
      where,
      include: getMessageInclude,
      orderBy: { createdAt: "desc" },
      take: limit + 1
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const messageIds = page.map((m) => m.id);

    const existingReads = await prisma.messageRead.findMany({
      where: {
        userId,
        messageId: { in: messageIds }
      },
      select: { messageId: true }
    });

    const readSet = new Set(existingReads.map((r) => r.messageId));
    const unreadIds = page.filter((m) => m.senderId !== userId && !readSet.has(m.id)).map((m) => m.id);

    if (unreadIds.length) {
      await prisma.messageRead.createMany({
        data: unreadIds.map((messageId) => ({ messageId, userId })),
        skipDuplicates: true
      });

      await prisma.conversationParticipant.update({
        where: {
          conversationId_userId: {
            conversationId,
            userId
          }
        },
        data: {
          lastReadMessageId: page[0]?.id || participant.lastReadMessageId,
          lastReadAt: new Date()
        }
      });

      for (const messageId of unreadIds) {
        io.to(`dm:${conversationId}`).emit("message:seen", {
          messageId,
          userId,
          timestamp: new Date().toISOString()
        });
        io.to(`conv:${conversationId}`).emit("message:seen", {
          messageId,
          userId,
          timestamp: new Date().toISOString()
        });
      }
    }

    const serialized = await Promise.all(
      page.map(async (message) => {
        const item = await serializeMessage(message, userId);

        if (item.encryption && item.content) {
          try {
            return {
              ...item,
              content: await decryptMessage(item.content, item.encryption, userId)
            };
          } catch {
            return {
              ...item,
              content: null,
              decryptionFailed: true
            };
          }
        }

        return item;
      })
    );

    return ok(res, {
      success: true,
      ok: true,
      messages: serialized.reverse(),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.createdAt : null
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to load messages");
  }
};

export const editMessage = async (req: Request, res: Response) => {
  try {
    const messageId = cleanString(req.body.messageId, 200);
    const content = typeof req.body.content === "string" ? req.body.content.slice(0, MAX_MESSAGE_LENGTH) : "";
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!messageId || !content.trim()) return fail(res, 400, "Invalid request");

    const message = await prisma.message.findUnique({ where: { id: messageId } });

    if (!message) return fail(res, 404, "Message not found");
    if (message.senderId !== userId) return fail(res, 403, "Cannot edit this message");
    if (message.deletedAt) return fail(res, 400, "Cannot edit deleted message");
    if (message.isScheduled && message.scheduledFor && message.scheduledFor <= new Date()) return fail(res, 400, "Cannot edit this scheduled message now");

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content,
        editedAt: new Date(),
        hashtags: extractHashtags(content),
        mentions: extractMentions(content),
        linkPreviews: (await generateLinkPreview(content)) as Prisma.InputJsonValue
      },
      include: getMessageInclude
    });

    const payload = await serializeMessage(updated, userId);

    io.to(`dm:${message.conversationId}`).emit("message:edited", payload);
    io.to(`conv:${message.conversationId}`).emit("message:edited", payload);

    return ok(res, {
      success: true,
      ok: true,
      message: payload
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to edit message");
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const messageId = cleanString(req.body.messageId, 200);
    const deleteForEveryone = Boolean(req.body.deleteForEveryone);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!messageId) return fail(res, 400, "messageId is required");

    const message = await prisma.message.findUnique({ where: { id: messageId } });

    if (!message) return fail(res, 404, "Message not found");

    const participant = await ensureConversationAccess(message.conversationId, userId, res);
    if (!participant) return;

    if (deleteForEveryone) {
      if (message.senderId !== userId && !isAdminParticipant(participant.role)) {
        return fail(res, 403, "Cannot delete for everyone");
      }

      await prisma.message.update({
        where: { id: messageId },
        data: {
          deletedAt: new Date(),
          content: null,
          mediaUrl: null,
          poll: Prisma.JsonNull,
          payment: Prisma.JsonNull,
          encryption: Prisma.JsonNull
        }
      });

      io.to(`dm:${message.conversationId}`).emit("message:deleted", {
        messageId,
        deletedForEveryone: true,
        timestamp: new Date().toISOString()
      });
      io.to(`conv:${message.conversationId}`).emit("message:deleted", {
        messageId,
        deletedForEveryone: true,
        timestamp: new Date().toISOString()
      });
    } else {
      if (!message.deletedFor.includes(userId)) {
        await prisma.message.update({
          where: { id: messageId },
          data: {
            deletedFor: {
              push: userId
            }
          }
        });
      }

      io.to(`user:${userId}`).emit("message:hidden", {
        messageId,
        timestamp: new Date().toISOString()
      });
    }

    return ok(res, {
      success: true,
      ok: true,
      status: "deleted"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to delete message");
  }
};

export const reactToMessage = async (req: Request, res: Response) => {
  try {
    const messageId = cleanString(req.body.messageId, 200);
    const emoji = cleanString(req.body.emoji, 30);
    const remove = Boolean(req.body.remove);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!messageId || !emoji) return fail(res, 400, "Invalid request");

    const message = await prisma.message.findUnique({ where: { id: messageId } });

    if (!message || message.deletedAt) return fail(res, 404, "Message not found");

    const participant = await ensureConversationAccess(message.conversationId, userId, res);
    if (!participant) return;

    if (remove) {
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
      by: ["emoji"],
      where: { messageId },
      _count: { emoji: true }
    });

    const reactionMap = Object.fromEntries(reactions.map((r) => [r.emoji, r._count.emoji]));

    const payload = {
      messageId,
      userId,
      emoji,
      removed: remove,
      reactions: reactionMap,
      timestamp: new Date().toISOString()
    };

    io.to(`dm:${message.conversationId}`).emit("message:reaction", payload);
    io.to(`conv:${message.conversationId}`).emit("message:reaction", payload);

    return ok(res, {
      success: true,
      ok: true,
      status: "ok",
      reactions: reactionMap
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to react to message");
  }
};

export const forwardMessage = async (req: Request, res: Response) => {
  try {
    const messageId = cleanString(req.body.messageId, 200);
    const conversationIds = normalizeStringArray(req.body.conversationIds, MAX_FORWARD_TARGETS);
    const comment = cleanString(req.body.comment, MAX_MESSAGE_LENGTH);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    if (!messageId || !conversationIds.length) {
      return fail(res, 400, "Invalid request");
    }

    const original = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!original || original.deletedAt || original.deletedFor.includes(userId)) {
      return fail(res, 404, "Message not found");
    }

    const sourceParticipant = await ensureConversationAccess(original.conversationId, userId, res);
    if (!sourceParticipant) return;

    const allowedConversations = await prisma.conversationParticipant.findMany({
      where: {
        userId,
        conversationId: { in: conversationIds }
      },
      select: { conversationId: true }
    });

    const allowedIds = allowedConversations.map((c) => c.conversationId);

    const forwarded = await Promise.all(
      allowedIds.map(async (conversationId) => {
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: {
            participants: {
              select: { userId: true }
            }
          }
        });

        if (!conversation) return null;

        const otherIds = conversation.participants.map((p) => p.userId).filter((id) => id !== userId);
        const allowed = await canMessageParticipants(userId, otherIds);

        if (!allowed) return null;

        const message = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            receiverId: conversation.type === ConversationType.DIRECT ? otherIds[0] || null : null,
            content: comment || original.content,
            mediaUrl: original.mediaUrl,
            mediaType: original.mediaType,
            forwardedFromId: original.id,
            hashtags: comment ? extractHashtags(comment) : original.hashtags,
            mentions: comment ? extractMentions(comment) : original.mentions,
            linkPreviews: comment ? ((await generateLinkPreview(comment)) as Prisma.InputJsonValue) : (original.linkPreviews as Prisma.InputJsonValue),
            status: MsgStatus.DELIVERED
          },
          include: getMessageInclude
        });

        await updateConversationLastMessage(conversationId, message.id);

        const payload = await serializeMessage(message, userId);

        await emitToConversationUsers(conversationId, "message:new", payload, userId);
        io.to(`user:${userId}`).emit("message:sent", payload);

        return payload;
      })
    );

    const messages = forwarded.filter(Boolean);

    return ok(res, {
      success: true,
      ok: true,
      status: "forwarded",
      count: messages.length,
      messages
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to forward message");
  }
};

export const pinMessage = async (req: Request, res: Response) => {
  try {
    const messageId = cleanString(req.body.messageId, 200);
    const conversationId = cleanString(req.body.conversationId, 200);
    const unpin = Boolean(req.body.unpin);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!messageId || !conversationId) return fail(res, 400, "Invalid request");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const message = await prisma.message.findUnique({ where: { id: messageId } });

    if (!message || message.conversationId !== conversationId || message.deletedAt) {
      return fail(res, 404, "Message not found");
    }

    if (message.senderId !== userId && !isAdminParticipant(participant.role)) {
      return fail(res, 403, "Cannot pin this message");
    }

    if (unpin) {
      await prisma.pinnedMessage.deleteMany({
        where: { conversationId, messageId }
      });

      await prisma.message.update({
        where: { id: messageId },
        data: { isPinned: false }
      });
    } else {
      await prisma.pinnedMessage.upsert({
        where: {
          conversationId_messageId: {
            conversationId,
            messageId
          }
        },
        update: {},
        create: {
          conversationId,
          messageId,
          pinnedBy: userId
        }
      });

      await prisma.message.update({
        where: { id: messageId },
        data: { isPinned: true }
      });
    }

    const payload = {
      conversationId,
      messageId,
      pinned: !unpin,
      userId,
      timestamp: new Date().toISOString()
    };

    io.to(`dm:${conversationId}`).emit("conversation:pinned_updated", payload);
    io.to(`conv:${conversationId}`).emit("conversation:pinned_updated", payload);

    return ok(res, {
      success: true,
      ok: true,
      status: unpin ? "unpinned" : "pinned"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update pinned message");
  }
};

export const replyToMessage = async (req: Request, res: Response) => {
  try {
    const messageId = req.params.messageId || req.params.id;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!messageId) return fail(res, 400, "messageId is required");

    const original = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true }
    });

    if (!original) return fail(res, 404, "Message not found");

    const participant = await ensureConversationAccess(original.conversationId, userId, res);
    if (!participant) return;

    const replies = await prisma.message.findMany({
      where: {
        replyToId: messageId,
        deletedAt: null,
        deletedFor: { not: { has: userId } }
      },
      include: {
        sender: {
          select: userSelect
        }
      },
      orderBy: { createdAt: "asc" },
      take: 50
    });

    return ok(res, {
      success: true,
      ok: true,
      replies
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to load replies");
  }
};

export const muteConversation = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const mute = req.body.mute !== false;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    await prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      data: {
        isMuted: Boolean(mute)
      }
    });

    io.to(`user:${userId}`).emit("conversation:muted", {
      conversationId,
      muted: Boolean(mute),
      timestamp: new Date().toISOString()
    });

    return ok(res, {
      success: true,
      ok: true,
      status: mute ? "muted" : "unmuted"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update mute status");
  }
};

export const archiveConversation = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const archive = req.body.archive !== false;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const latest = !archive
      ? await prisma.message.findFirst({
          where: {
            conversationId,
            deletedAt: null,
            deletedFor: { not: { has: userId } }
          },
          orderBy: { createdAt: "desc" }
        })
      : null;

    await prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      data: {
        isArchived: Boolean(archive),
        ...(archive
          ? {}
          : {
              lastReadMessageId: latest?.id || participant.lastReadMessageId,
              lastReadAt: new Date()
            })
      }
    });

    io.to(`user:${userId}`).emit("conversation:archived", {
      conversationId,
      archived: Boolean(archive),
      timestamp: new Date().toISOString()
    });

    return ok(res, {
      success: true,
      ok: true,
      status: archive ? "archived" : "unarchived"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update archive status");
  }
};

export const blockUser = async (req: Request, res: Response) => {
  try {
    const targetId = cleanString(req.body.userId, 200);
    const reason = cleanString(req.body.reason, 500) || null;
    const blockerId = getUserId(req);

    if (!blockerId) return fail(res, 401, "Unauthorized");
    if (!targetId || targetId === blockerId) return fail(res, 400, "Invalid user");

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true }
    });

    if (!target) return fail(res, 404, "User not found");

    await prisma.blockedUser.upsert({
      where: {
        blockerId_blockedId: {
          blockerId,
          blockedId: targetId
        }
      },
      update: {
        reason,
        createdAt: new Date()
      },
      create: {
        blockerId,
        blockedId: targetId,
        reason
      }
    });

    const directConversation = await getDirectConversation(blockerId, targetId);

    if (directConversation) {
      await prisma.conversationParticipant.updateMany({
        where: {
          conversationId: directConversation.id,
          userId: blockerId
        },
        data: {
          isArchived: true
        }
      });

      const payload = {
        conversationId: directConversation.id,
        blockerId,
        blockedId: targetId,
        timestamp: new Date().toISOString()
      };

      io.to(`dm:${directConversation.id}`).emit("conversation:blocked", payload);
      io.to(`conv:${directConversation.id}`).emit("conversation:blocked", payload);
    }

    io.to(`user:${targetId}`).emit("user:blocked", {
      by: blockerId,
      timestamp: new Date().toISOString()
    });

    return ok(res, {
      success: true,
      ok: true,
      status: "blocked"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to block user");
  }
};

export const unblockUser = async (req: Request, res: Response) => {
  try {
    const targetId = cleanString(req.body.userId, 200);
    const blockerId = getUserId(req);

    if (!blockerId) return fail(res, 401, "Unauthorized");
    if (!targetId || targetId === blockerId) return fail(res, 400, "Invalid user");

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId,
        blockedId: targetId
      }
    });

    io.to(`user:${targetId}`).emit("user:unblocked", {
      by: blockerId,
      timestamp: new Date().toISOString()
    });

    return ok(res, {
      success: true,
      ok: true,
      status: "unblocked"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to unblock user");
  }
};

export const searchMessages = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const query = cleanString(req.query.query, 200);
    const limit = safeNumber(req.query.limit, 20, 50);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!conversationId || !query) return fail(res, 400, "conversationId and query are required");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        deletedFor: { not: { has: userId } },
        OR: [
          { content: { contains: query, mode: "insensitive" } },
          { hashtags: { has: query } },
          { mentions: { has: query } }
        ]
      },
      include: {
        sender: {
          select: userSelect
        },
        replyTo: {
          select: {
            id: true,
            content: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });

    return ok(res, {
      success: true,
      ok: true,
      messages
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to search messages");
  }
};

export const exportChat = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const format = String(req.query.format || "json").toLowerCase();
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!conversationId) return fail(res, 400, "conversationId is required");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        deletedFor: { not: { has: userId } }
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            fullName: true
          }
        }
      },
      orderBy: { createdAt: "asc" }
    });

    if (format === "txt") {
      const text = messages
        .map((message) => {
          const date = new Date(message.createdAt).toISOString();
          const sender = message.sender?.username || "Unknown";
          const body = message.content || (message.mediaUrl ? "[Media]" : "[Empty]");
          return `[${date}] ${sender}: ${body}`;
        })
        .join("\n");

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="chat_${conversationId}.txt"`);
      return res.send(text);
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="chat_${conversationId}.json"`);
    return res.send(
      JSON.stringify(
        {
          conversationId,
          exportedAt: new Date().toISOString(),
          messageCount: messages.length,
          messages
        },
        null,
        2
      )
    );
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to export chat");
  }
};

export const saveDraft = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const content = typeof req.body.content === "string" ? req.body.content.slice(0, MAX_MESSAGE_LENGTH) : null;
    const media = req.body.media && typeof req.body.media === "object" ? req.body.media : undefined;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const draft = await prisma.draftMessage.upsert({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      update: {
        content,
        media: media as Prisma.InputJsonValue,
        updatedAt: new Date()
      },
      create: {
        conversationId,
        userId,
        content,
        media: media as Prisma.InputJsonValue
      }
    });

    io.to(`dm:${conversationId}`).emit("typing:draft_saved", {
      conversationId,
      userId,
      updatedAt: draft.updatedAt
    });
    io.to(`conv:${conversationId}`).emit("typing:draft_saved", {
      conversationId,
      userId,
      updatedAt: draft.updatedAt
    });

    return ok(res, {
      success: true,
      ok: true,
      draft
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to save draft");
  }
};

export const getDraft = async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId || req.params.id;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const draft = await prisma.draftMessage.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      }
    });

    return ok(res, {
      success: true,
      ok: true,
      draft: draft || null
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to load draft");
  }
};

export const clearDraft = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    await prisma.draftMessage.deleteMany({
      where: {
        conversationId,
        userId
      }
    });

    return ok(res, {
      success: true,
      ok: true,
      status: "cleared"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to clear draft");
  }
};

export const markSeen = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const userId = getUserId(req);
    const ids = normalizeStringArray(req.body.messageIds, 500);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    if (!ids.length) {
      return ok(res, {
        success: true,
        ok: true,
        status: "ok",
        count: 0
      });
    }

    const messages = await prisma.message.findMany({
      where: {
        id: { in: ids },
        conversationId,
        senderId: { not: userId },
        deletedAt: null,
        deletedFor: { not: { has: userId } }
      },
      select: {
        id: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    await prisma.messageRead.createMany({
      data: messages.map((message) => ({
        messageId: message.id,
        userId
      })),
      skipDuplicates: true
    });

    await prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      data: {
        lastReadMessageId: messages[0]?.id || participant.lastReadMessageId,
        lastReadAt: new Date()
      }
    });

    for (const message of messages) {
      const payload = {
        messageId: message.id,
        userId,
        timestamp: new Date().toISOString()
      };
      io.to(`dm:${conversationId}`).emit("message:seen", payload);
      io.to(`conv:${conversationId}`).emit("message:seen", payload);
    }

    return ok(res, {
      success: true,
      ok: true,
      status: "ok",
      count: messages.length
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to mark messages as seen");
  }
};

export const setTyping = async (req: Request, res: Response) => {
  try {
    const conversationId = cleanString(req.body.conversationId, 200);
    const isTyping = req.body.isTyping !== false;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const typing = await prisma.typingIndicator.upsert({
      where: {
        conversationId_userId: {
          conversationId,
          userId
        }
      },
      update: {
        isTyping: Boolean(isTyping),
        updatedAt: new Date()
      },
      create: {
        conversationId,
        userId,
        isTyping: Boolean(isTyping)
      }
    });

    const payload = {
      conversationId,
      userId,
      isTyping: Boolean(isTyping),
      updatedAt: typing.updatedAt
    };

    io.to(`dm:${conversationId}`).emit("typing:update", payload);
    io.to(`conv:${conversationId}`).emit("typing:update", payload);

    return ok(res, {
      success: true,
      ok: true,
      status: "ok"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update typing status");
  }
};

export const updateChatTheme = async (req: Request, res: Response) => {
  try {
    const rawConversationId = cleanString(req.body.conversationId, 200);
    const conversationId = rawConversationId || null;
    const backgroundImage = cleanString(req.body.backgroundImage, 1000) || null;
    const bubbleColor = cleanString(req.body.bubbleColor, 50) || null;
    const textColor = cleanString(req.body.textColor, 50) || null;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");

    if (conversationId) {
      const participant = await ensureConversationAccess(conversationId, userId, res);
      if (!participant) return;
    }

    const existing = await prisma.chatTheme.findFirst({
      where: {
        userId,
        conversationId
      }
    });

    const theme = existing
      ? await prisma.chatTheme.update({
          where: { id: existing.id },
          data: {
            backgroundImage,
            bubbleColor,
            textColor,
            updatedAt: new Date()
          }
        })
      : await prisma.chatTheme.create({
          data: {
            userId,
            conversationId,
            backgroundImage,
            bubbleColor,
            textColor
          }
        });

    if (conversationId) {
      const payload = {
        conversationId,
        userId,
        theme,
        timestamp: new Date().toISOString()
      };

      io.to(`dm:${conversationId}`).emit("conversation:theme_updated", payload);
      io.to(`conv:${conversationId}`).emit("conversation:theme_updated", payload);
    }

    return ok(res, {
      success: true,
      ok: true,
      theme
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update chat theme");
  }
};

export const createChatFolder = async (req: Request, res: Response) => {
  try {
    const name = cleanString(req.body.name, MAX_FOLDER_NAME_LENGTH);
    const icon = cleanString(req.body.icon, 100) || null;
    const color = cleanString(req.body.color, 50) || null;
    const conversationIds = normalizeStringArray(req.body.conversationIds, 500);
    const position = Number.isFinite(Number(req.body.position)) ? Math.floor(Number(req.body.position)) : 0;
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!name) return fail(res, 400, "Folder name is required");

    if (conversationIds.length) {
      const allowedCount = await prisma.conversationParticipant.count({
        where: {
          userId,
          conversationId: { in: conversationIds }
        }
      });

      if (allowedCount !== conversationIds.length) {
        return fail(res, 403, "One or more conversations are not accessible");
      }
    }

    const folder = await prisma.chatFolder.create({
      data: {
        userId,
        name,
        icon,
        color,
        conversationIds,
        position
      }
    });

    return ok(
      res,
      {
        success: true,
        ok: true,
        folder
      },
      201
    );
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to create chat folder");
  }
};

export const updateChatFolder = async (req: Request, res: Response) => {
  try {
    const folderId = cleanString(req.body.folderId || req.params.folderId || req.params.id, 200);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!folderId) return fail(res, 400, "folderId is required");

    const folder = await prisma.chatFolder.findFirst({
      where: {
        id: folderId,
        userId
      }
    });

    if (!folder) return fail(res, 404, "Folder not found");

    const data: Prisma.ChatFolderUpdateInput = {};

    if (req.body.name !== undefined) {
      const name = cleanString(req.body.name, MAX_FOLDER_NAME_LENGTH);
      if (!name) return fail(res, 400, "Folder name cannot be empty");
      data.name = name;
    }

    if (req.body.icon !== undefined) data.icon = cleanString(req.body.icon, 100) || null;
    if (req.body.color !== undefined) data.color = cleanString(req.body.color, 50) || null;

    if (req.body.conversationIds !== undefined) {
      const conversationIds = normalizeStringArray(req.body.conversationIds, 500);

      if (conversationIds.length) {
        const allowedCount = await prisma.conversationParticipant.count({
          where: {
            userId,
            conversationId: { in: conversationIds }
          }
        });

        if (allowedCount !== conversationIds.length) {
          return fail(res, 403, "One or more conversations are not accessible");
        }
      }

      data.conversationIds = conversationIds;
    }

    if (req.body.position !== undefined) {
      data.position = Number.isFinite(Number(req.body.position)) ? Math.floor(Number(req.body.position)) : folder.position;
    }

    const updated = await prisma.chatFolder.update({
      where: { id: folderId },
      data
    });

    return ok(res, {
      success: true,
      ok: true,
      folder: updated
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to update chat folder");
  }
};

export const deleteChatFolder = async (req: Request, res: Response) => {
  try {
    const folderId = cleanString(req.body.folderId || req.params.folderId || req.params.id, 200);
    const userId = getUserId(req);

    if (!userId) return fail(res, 401, "Unauthorized");
    if (!folderId) return fail(res, 400, "folderId is required");

    await prisma.chatFolder.deleteMany({
      where: {
        id: folderId,
        userId
      }
    });

    return ok(res, {
      success: true,
      ok: true,
      status: "deleted"
    });
  } catch (error: any) {
    return fail(res, 500, error?.message || "Failed to delete chat folder");
  }
};
