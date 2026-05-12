import { Request, Response } from "express";
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

const safeNumber = (value: unknown, fallback: number, max = 100) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
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
  participantIds.forEach((id) => {
    if (id !== excludeUserId) io.to(`user:${id}`).emit(event, payload);
  });
  io.to(`conv:${conversationId}`).emit(event, payload);
};

const ensureConversationAccess = async (conversationId: string, userId: string, res: Response) => {
  const participant = await isParticipant(conversationId, userId);
  if (!participant) {
    res.status(403).json({ error: "Access denied" });
    return null;
  }
  return participant;
};

const getDirectConversation = async (userA: string, userB: string) => {
  const conversations = await prisma.conversation.findMany({
    where: {
      type: "direct",
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

  return conversations.find((conversation) => {
    const ids = conversation.participants.map((p) => p.userId);
    return ids.length === 2 && ids.includes(userA) && ids.includes(userB);
  });
};

const normalizeParticipantIds = (creatorId: string, participantIds: unknown) => {
  if (!Array.isArray(participantIds)) return [];
  return [...new Set(participantIds.filter((id) => typeof id === "string" && id && id !== creatorId))];
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

export const createConversation = async (req: Request, res: Response) => {
  try {
    const { type = "direct", participantIds = [], name, avatarUrl } = req.body;
    const creatorId = req.userId!;

    const normalizedIds = normalizeParticipantIds(creatorId, participantIds);

    if (type === "direct") {
      if (normalizedIds.length !== 1) return res.status(400).json({ error: "Direct conversation requires exactly one participant" });

      const blocked = await prisma.blockedUser.findFirst({
        where: {
          OR: [
            { blockerId: creatorId, blockedId: normalizedIds[0] },
            { blockerId: normalizedIds[0], blockedId: creatorId }
          ]
        }
      });

      if (blocked) return res.status(403).json({ error: "Cannot create conversation with blocked user" });

      const existing = await getDirectConversation(creatorId, normalizedIds[0]);
      if (existing) return res.json(existing);
    }

    if (type === "group" && normalizedIds.length < 1) {
      return res.status(400).json({ error: "Group conversation requires participants" });
    }

    const conversation = await prisma.conversation.create({
      data: {
        type,
        name: type === "group" ? name : null,
        avatarUrl: type === "group" ? avatarUrl : null,
        participants: {
          create: [
            { userId: creatorId, role: "admin" },
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

    conversation.participants.forEach((participant) => {
      if (participant.userId !== creatorId) io.to(`user:${participant.userId}`).emit("conversation:new", conversation);
    });

    res.status(201).json(conversation);
  } catch (error) {
    res.status(500).json({ error: "Failed to create conversation" });
  }
};

export const getConversations = async (req: Request, res: Response) => {
  try {
    const limit = safeNumber(req.query.limit, 50, 100);
    const includeArchived = req.query.includeArchived === "true";
    const userId = req.userId!;

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
          viewerParticipant: viewer
        };
      })
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to load conversations" });
  }
};

export const getConversation = async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.id;
    const userId = req.userId!;

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
        }
      }
    });

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

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: "Failed to load conversation" });
  }
};

export const sendMessage = async (req: Request, res: Response) => {
  try {
    const {
      conversationId,
      content,
      media,
      replyToId,
      scheduledFor,
      expiresAt,
      poll,
      payment,
      isEncrypted = false
    } = req.body;

    const senderId = req.userId!;

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

    if (!conversation) return res.status(404).json({ error: "Conversation not found" });

    const otherParticipantIds = conversation.participants.map((p) => p.userId).filter((id) => id !== senderId);

    const blocked = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: senderId, blockedId: { in: otherParticipantIds } },
          { blockerId: { in: otherParticipantIds }, blockedId: senderId }
        ]
      }
    });

    if (blocked) return res.status(403).json({ error: "Cannot message blocked user" });

    if (!content && !req.file && !media && !poll && !payment) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const hashtags = extractHashtags(content || "");
    const mentions = extractMentions(content || "");
    const linkPreviews = content ? await generateLinkPreview(content) : [];

    let finalContent = content || null;
    let encryptionData: any = null;

    if (isEncrypted && content) {
      const encryptedPayload = await encryptMessage(content, senderId);
      finalContent = encryptedPayload.encrypted;
      encryptionData = {
        algorithm: "AES-GCM",
        keyId: encryptedPayload.keyId,
        iv: encryptedPayload.iv
      };
    }

    let mediaUrl: string | null = media?.url || null;

    if (req.file) {
      const folder = media?.type === "voice" ? "voice_notes" : media?.type === "video" ? "dm_videos" : "dm_images";
      mediaUrl = await uploadToCloudinary(req.file, folder);
    }

    const message = await prisma.message.create({
      data: {
        conversationId,
        senderId,
        receiverId: conversation.type === "direct" ? otherParticipantIds[0] || null : null,
        content: finalContent,
        mediaUrl,
        replyToId: replyToId || null,
        hashtags,
        mentions,
        linkPreviews,
        poll: poll || undefined,
        payment: payment || undefined,
        encryption: encryptionData || undefined,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isScheduled: Boolean(scheduledFor),
        status: scheduledFor ? "SENT" : "DELIVERED"
      },
      include: {
        sender: {
          select: userSelect
        },
        replyTo: {
          include: {
            sender: {
              select: userSelect
            }
          }
        }
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageId: message.id,
        updatedAt: new Date()
      }
    });

    await prisma.draftMessage.deleteMany({
      where: {
        conversationId,
        userId: senderId
      }
    });

    const payload = await serializeMessage(message, senderId);

    await emitToConversationUsers(conversationId, "message:new", payload, senderId);
    io.to(`user:${senderId}`).emit("message:sent", payload);

    res.status(201).json(payload);
  } catch (error) {
    res.status(500).json({ error: "Failed to send message" });
  }
};

export const getMessages = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const userId = req.userId!;
    const limit = safeNumber(req.query.limit, 50, 100);
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const after = req.query.after ? new Date(String(req.query.after)) : null;
    const search = req.query.search ? String(req.query.search) : null;

    if (!conversationId) return res.status(400).json({ error: "conversationId is required" });

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const where: any = {
      conversationId,
      deletedAt: null,
      deletedFor: { not: { has: userId } }
    };

    if (before) where.createdAt = { ...(where.createdAt || {}), lt: before };
    if (after) where.createdAt = { ...(where.createdAt || {}), gt: after };

    if (search) {
      where.OR = [
        { content: { contains: search, mode: "insensitive" } },
        { hashtags: { has: search } },
        { mentions: { has: search } }
      ];
    }

    const messages = await prisma.message.findMany({
      where,
      include: {
        sender: {
          select: userSelect
        },
        replyTo: {
          include: {
            sender: {
              select: userSelect
            }
          }
        }
      },
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

      unreadIds.forEach((messageId) => {
        io.to(`conv:${conversationId}`).emit("message:seen", {
          messageId,
          userId,
          timestamp: new Date()
        });
      });
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

    res.json({
      messages: serialized.reverse(),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.createdAt : null
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load messages" });
  }
};

export const editMessage = async (req: Request, res: Response) => {
  try {
    const { messageId, content } = req.body;
    const userId = req.userId!;

    if (!messageId || typeof content !== "string") return res.status(400).json({ error: "Invalid request" });

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.senderId !== userId) return res.status(403).json({ error: "Cannot edit this message" });
    if (message.deletedAt) return res.status(400).json({ error: "Cannot edit deleted message" });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content,
        editedAt: new Date(),
        hashtags: extractHashtags(content),
        mentions: extractMentions(content),
        linkPreviews: await generateLinkPreview(content)
      },
      include: {
        sender: {
          select: userSelect
        }
      }
    });

    io.to(`conv:${message.conversationId}`).emit("message:edited", updated);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to edit message" });
  }
};

export const deleteMessage = async (req: Request, res: Response) => {
  try {
    const { messageId, deleteForEveryone = false } = req.body;
    const userId = req.userId!;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: "Message not found" });

    const participant = await ensureConversationAccess(message.conversationId, userId, res);
    if (!participant) return;

    if (deleteForEveryone) {
      if (message.senderId !== userId && participant.role !== "admin") {
        return res.status(403).json({ error: "Cannot delete for everyone" });
      }

      await prisma.message.update({
        where: { id: messageId },
        data: {
          deletedAt: new Date(),
          content: null,
          mediaUrl: null
        }
      });

      io.to(`conv:${message.conversationId}`).emit("message:deleted", {
        messageId,
        deletedForEveryone: true
      });
    } else {
      await prisma.message.update({
        where: { id: messageId },
        data: {
          deletedFor: {
            push: userId
          }
        }
      });

      io.to(`user:${userId}`).emit("message:hidden", { messageId });
    }

    res.json({ status: "deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete message" });
  }
};

export const reactToMessage = async (req: Request, res: Response) => {
  try {
    const { messageId, emoji, remove = false } = req.body;
    const userId = req.userId!;

    if (!messageId || !emoji) return res.status(400).json({ error: "Invalid request" });

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) return res.status(404).json({ error: "Message not found" });

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

    io.to(`conv:${message.conversationId}`).emit("message:reaction", {
      messageId,
      userId,
      emoji,
      removed: remove,
      reactions: reactionMap
    });

    res.json({ status: "ok", reactions: reactionMap });
  } catch (error) {
    res.status(500).json({ error: "Failed to react to message" });
  }
};

export const forwardMessage = async (req: Request, res: Response) => {
  try {
    const { messageId, conversationIds, comment } = req.body;
    const userId = req.userId!;

    if (!messageId || !Array.isArray(conversationIds) || !conversationIds.length) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const original = await prisma.message.findUnique({ where: { id: messageId } });
    if (!original) return res.status(404).json({ error: "Message not found" });

    const sourceParticipant = await ensureConversationAccess(original.conversationId, userId, res);
    if (!sourceParticipant) return;

    const uniqueConversationIds = [...new Set(conversationIds.filter((id: unknown) => typeof id === "string"))];

    const allowedConversations = await prisma.conversationParticipant.findMany({
      where: {
        userId,
        conversationId: { in: uniqueConversationIds }
      },
      select: { conversationId: true }
    });

    const allowedIds = allowedConversations.map((c) => c.conversationId);

    const forwarded = await Promise.all(
      allowedIds.map(async (conversationId) => {
        const message = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            content: comment || original.content,
            mediaUrl: original.mediaUrl,
            forwardedFromId: original.id,
            hashtags: original.hashtags,
            mentions: original.mentions,
            linkPreviews: original.linkPreviews || undefined,
            status: "DELIVERED"
          },
          include: {
            sender: {
              select: userSelect
            },
            forwardedFrom: {
              include: {
                sender: {
                  select: userSelect
                }
              }
            }
          }
        });

        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageId: message.id,
            updatedAt: new Date()
          }
        });

        await emitToConversationUsers(conversationId, "message:new", message, userId);

        return message;
      })
    );

    res.json({ status: "forwarded", count: forwarded.length, messages: forwarded });
  } catch (error) {
    res.status(500).json({ error: "Failed to forward message" });
  }
};

export const pinMessage = async (req: Request, res: Response) => {
  try {
    const { messageId, conversationId, unpin = false } = req.body;
    const userId = req.userId!;

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.conversationId !== conversationId) return res.status(404).json({ error: "Message not found" });

    if (message.senderId !== userId && participant.role !== "admin") {
      return res.status(403).json({ error: "Cannot pin this message" });
    }

    if (unpin) {
      await prisma.pinnedMessage.deleteMany({
        where: { conversationId, messageId }
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
    }

    io.to(`conv:${conversationId}`).emit("conversation:pinned_updated", {
      conversationId,
      messageId,
      pinned: !unpin
    });

    res.json({ status: unpin ? "unpinned" : "pinned" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update pinned message" });
  }
};

export const replyToMessage = async (req: Request, res: Response) => {
  try {
    const messageId = req.params.messageId || req.params.id;
    const userId = req.userId!;

    const original = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversationId: true }
    });

    if (!original) return res.status(404).json({ error: "Message not found" });

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

    res.json(replies);
  } catch (error) {
    res.status(500).json({ error: "Failed to load replies" });
  }
};

export const muteConversation = async (req: Request, res: Response) => {
  try {
    const { conversationId, mute = true } = req.body;
    const userId = req.userId!;

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
      muted: Boolean(mute)
    });

    res.json({ status: mute ? "muted" : "unmuted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update mute status" });
  }
};

export const archiveConversation = async (req: Request, res: Response) => {
  try {
    const { conversationId, archive = true } = req.body;
    const userId = req.userId!;

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
      archived: Boolean(archive)
    });

    res.json({ status: archive ? "archived" : "unarchived" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update archive status" });
  }
};

export const blockUser = async (req: Request, res: Response) => {
  try {
    const { userId: targetId, reason } = req.body;
    const blockerId = req.userId!;

    if (!targetId || targetId === blockerId) return res.status(400).json({ error: "Invalid user" });

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

      io.to(`conv:${directConversation.id}`).emit("conversation:blocked", {
        conversationId: directConversation.id,
        blockerId,
        blockedId: targetId
      });
    }

    io.to(`user:${targetId}`).emit("user:blocked", { by: blockerId });
    res.json({ status: "blocked" });
  } catch (error) {
    res.status(500).json({ error: "Failed to block user" });
  }
};

export const unblockUser = async (req: Request, res: Response) => {
  try {
    const { userId: targetId } = req.body;
    const blockerId = req.userId!;

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId,
        blockedId: targetId
      }
    });

    io.to(`user:${targetId}`).emit("user:unblocked", { by: blockerId });
    res.json({ status: "unblocked" });
  } catch (error) {
    res.status(500).json({ error: "Failed to unblock user" });
  }
};

export const searchMessages = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const query = String(req.query.query || "").trim();
    const limit = safeNumber(req.query.limit, 20, 50);
    const userId = req.userId!;

    if (!conversationId || !query) return res.status(400).json({ error: "conversationId and query are required" });

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

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: "Failed to search messages" });
  }
};

export const exportChat = async (req: Request, res: Response) => {
  try {
    const conversationId = String(req.query.conversationId || "");
    const format = String(req.query.format || "json");
    const userId = req.userId!;

    if (!conversationId) return res.status(400).json({ error: "conversationId is required" });

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
    res.send(
      JSON.stringify(
        {
          conversationId,
          exportedAt: new Date(),
          messageCount: messages.length,
          messages
        },
        null,
        2
      )
    );
  } catch (error) {
    res.status(500).json({ error: "Failed to export chat" });
  }
};

export const saveDraft = async (req: Request, res: Response) => {
  try {
    const { conversationId, content, media } = req.body;
    const userId = req.userId!;

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
        media,
        updatedAt: new Date()
      },
      create: {
        conversationId,
        userId,
        content,
        media
      }
    });

    io.to(`conv:${conversationId}`).emit("typing:draft_saved", {
      conversationId,
      userId,
      updatedAt: draft.updatedAt
    });

    res.json(draft);
  } catch (error) {
    res.status(500).json({ error: "Failed to save draft" });
  }
};

export const getDraft = async (req: Request, res: Response) => {
  try {
    const conversationId = req.params.conversationId || req.params.id;
    const userId = req.userId!;

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

    res.json(draft || null);
  } catch (error) {
    res.status(500).json({ error: "Failed to load draft" });
  }
};

export const clearDraft = async (req: Request, res: Response) => {
  try {
    const { conversationId } = req.body;
    const userId = req.userId!;

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    await prisma.draftMessage.deleteMany({
      where: {
        conversationId,
        userId
      }
    });

    res.json({ status: "cleared" });
  } catch (error) {
    res.status(500).json({ error: "Failed to clear draft" });
  }
};

export const markSeen = async (req: Request, res: Response) => {
  try {
    const { conversationId, messageIds = [] } = req.body;
    const userId = req.userId!;

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    const ids = Array.isArray(messageIds) ? messageIds.filter((id) => typeof id === "string") : [];

    if (!ids.length) return res.json({ status: "ok", count: 0 });

    const messages = await prisma.message.findMany({
      where: {
        id: { in: ids },
        conversationId,
        senderId: { not: userId }
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

    messages.forEach((message) => {
      io.to(`conv:${conversationId}`).emit("message:seen", {
        messageId: message.id,
        userId,
        timestamp: new Date()
      });
    });

    res.json({ status: "ok", count: messages.length });
  } catch (error) {
    res.status(500).json({ error: "Failed to mark messages as seen" });
  }
};

export const setTyping = async (req: Request, res: Response) => {
  try {
    const { conversationId, isTyping = true } = req.body;
    const userId = req.userId!;

    const participant = await ensureConversationAccess(conversationId, userId, res);
    if (!participant) return;

    await prisma.typingIndicator.upsert({
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

    io.to(`conv:${conversationId}`).emit("typing:update", {
      conversationId,
      userId,
      isTyping: Boolean(isTyping),
      updatedAt: new Date()
    });

    res.json({ status: "ok" });
  } catch (error) {
    res.status(500).json({ error: "Failed to update typing status" });
  }
};

export const updateChatTheme = async (req: Request, res: Response) => {
  try {
    const { conversationId, backgroundImage, bubbleColor, textColor } = req.body;
    const userId = req.userId!;

    if (conversationId) {
      const participant = await ensureConversationAccess(conversationId, userId, res);
      if (!participant) return;
    }

    const theme = await prisma.chatTheme.upsert({
      where: {
        userId_conversationId: {
          userId,
          conversationId: conversationId || ""
        }
      },
      update: {
        backgroundImage,
        bubbleColor,
        textColor,
        updatedAt: new Date()
      },
      create: {
        userId,
        conversationId: conversationId || "",
        backgroundImage,
        bubbleColor,
        textColor
      }
    });

    if (conversationId) {
      io.to(`conv:${conversationId}`).emit("conversation:theme_updated", {
        conversationId,
        userId,
        theme
      });
    }

    res.json(theme);
  } catch (error) {
    res.status(500).json({ error: "Failed to update chat theme" });
  }
};

export const createChatFolder = async (req: Request, res: Response) => {
  try {
    const { name, icon, color, conversationIds = [], position = 0 } = req.body;
    const userId = req.userId!;

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

    res.status(201).json(folder);
  } catch (error) {
    res.status(500).json({ error: "Failed to create chat folder" });
  }
};

export const updateChatFolder = async (req: Request, res: Response) => {
  try {
    const { folderId, name, icon, color, conversationIds, position } = req.body;
    const userId = req.userId!;

    const folder = await prisma.chatFolder.findFirst({
      where: {
        id: folderId,
        userId
      }
    });

    if (!folder) return res.status(404).json({ error: "Folder not found" });

    const updated = await prisma.chatFolder.update({
      where: { id: folderId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(conversationIds !== undefined ? { conversationIds } : {}),
        ...(position !== undefined ? { position } : {})
      }
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update chat folder" });
  }
};

export const deleteChatFolder = async (req: Request, res: Response) => {
  try {
    const { folderId } = req.body;
    const userId = req.userId!;

    await prisma.chatFolder.deleteMany({
      where: {
        id: folderId,
        userId
      }
    });

    res.json({ status: "deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete chat folder" });
  }
};
