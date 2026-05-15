import { Server, Socket, Namespace } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { MsgStatus } from '@prisma/client';

type DMAuthPayload = {
  userId?: string;
  id?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

type Ack<T = any> = (response: T) => void;

type SocketUserData = {
  userId: string;
  role?: string | null;
};

type ConversationPayload = {
  conversationId?: string;
};

type MessageSeenPayload = {
  conversationId?: string;
  messageIds?: string[];
};

type ReactionPayload = {
  messageId?: string;
  emoji?: string;
  remove?: boolean;
};

type CallPayload = {
  conversationId?: string;
  offer?: any;
  answer?: any;
  candidate?: any;
  targetUserId?: string;
  type?: string;
  reason?: string;
};

type PaymentInitiatePayload = {
  conversationId?: string;
  amount?: number;
  recipientId?: string;
};

type PaymentConfirmPayload = {
  messageId?: string;
};

type PollVotePayload = {
  messageId?: string;
  optionIndex?: number;
};

type DisappearingPayload = {
  messageId?: string;
  seconds?: number;
};

type FolderUpdatePayload = {
  folderId?: string;
  conversationIds?: string[];
};

const USER_ROOM_PREFIX = 'user';
const CONVERSATION_ROOM_PREFIX = 'conv';
const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 120;
const TYPING_CLEAR_MS = 5000;
const MAX_MESSAGE_SEEN_BATCH = 100;
const MAX_PAYMENT_AMOUNT = 1_000_000;
const MAX_DISAPPEARING_SECONDS = 60 * 60 * 24 * 30;

const typingTimers = new Map<string, NodeJS.Timeout>();
const connectedSockets = new Map<string, number>();
const socketBuckets = new Map<string, { count: number; resetAt: number }>();

function safeAck(ack: Ack | undefined, response: any) {
  if (typeof ack === 'function') ack(response);
}

function room(prefix: string, id: string) {
  return `${prefix}:${id}`;
}

function getSocketUser(socket: Socket): SocketUserData {
  const data = socket.data as Partial<SocketUserData>;
  return {
    userId: String(data.userId || ''),
    role: data.role || null
  };
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

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isSafeEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 32;
}

function normalizeAmount(value: unknown) {
  const amount = Number(value);
  return Number.isInteger(amount) ? amount : 0;
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
      socket.emit('dm:error', {
        code: 'RATE_LIMITED',
        message: 'Too many socket events',
        at: new Date().toISOString()
      });
      return;
    }

    next();
  });
}

function isAdminRole(role?: string | null) {
  const normalized = String(role || '').toLowerCase();
  return ['admin', 'super_admin', 'superadmin', 'owner'].includes(normalized);
}

function notDeletedForUserWhere(userId: string) {
  return {
    OR: [
      { deletedFor: { isEmpty: true } },
      { NOT: { deletedFor: { has: userId } } }
    ]
  };
}

async function getActiveUser(userId: string, fallbackRole?: string | null) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isBanned: true
    }
  });

  if (!user || user.isBanned) return null;

  return {
    id: user.id,
    role: String(user.role || fallbackRole || '').toLowerCase()
  };
}

async function isParticipant(conversationId: string, userId: string) {
  if (!isValidId(conversationId) || !isValidId(userId)) return null;

  return prisma.conversationParticipant.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId
      }
    }
  }).catch(() => null);
}

async function canAccessConversation(conversationId: string, userId: string, role?: string | null) {
  if (!isValidId(conversationId) || !isValidId(userId)) return false;

  if (isAdminRole(role)) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true }
    }).catch(() => null);

    if (conversation) return true;
  }

  const participant = await isParticipant(conversationId, userId);
  return !!participant;
}

async function getConversationParticipantIds(conversationId: string) {
  if (!isValidId(conversationId)) return [];

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true }
  }).catch(() => []);

  return participants.map(p => p.userId).filter((id): id is string => isValidId(id));
}

async function emitToConversationUsers(ns: Namespace, conversationId: string, event: string, payload: any, excludeUserId?: string) {
  const userIds = await getConversationParticipantIds(conversationId);

  userIds.forEach(id => {
    if (id !== excludeUserId) {
      ns.to(room(USER_ROOM_PREFIX, id)).emit(event, payload);
    }
  });

  ns.to(room(CONVERSATION_ROOM_PREFIX, conversationId)).emit(event, payload);
}

function typingKey(conversationId: string, userId: string) {
  return `${conversationId}:${userId}`;
}

async function clearTyping(ns: Namespace, conversationId: string, userId: string) {
  const key = typingKey(conversationId, userId);
  const timer = typingTimers.get(key);

  if (timer) clearTimeout(timer);

  typingTimers.delete(key);

  await prisma.typingIndicator.deleteMany({
    where: {
      conversationId,
      userId
    }
  }).catch(() => null);

  await emitToConversationUsers(ns, conversationId, 'typing:indicator', {
    conversationId,
    userId,
    isTyping: false,
    timestamp: new Date().toISOString()
  }, userId);
}

async function scheduleTypingClear(ns: Namespace, conversationId: string, userId: string) {
  const key = typingKey(conversationId, userId);
  const oldTimer = typingTimers.get(key);

  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    clearTyping(ns, conversationId, userId).catch(() => null);
  }, TYPING_CLEAR_MS);

  typingTimers.set(key, timer);
}

async function clearAllTypingForUser(ns: Namespace, userId: string) {
  const keys = [...typingTimers.keys()].filter(key => key.endsWith(`:${userId}`));

  keys.forEach(key => {
    const timer = typingTimers.get(key);
    if (timer) clearTimeout(timer);
    typingTimers.delete(key);
  });

  const activeTyping = await prisma.typingIndicator.findMany({
    where: { userId },
    select: { conversationId: true }
  }).catch(() => []);

  await prisma.typingIndicator.deleteMany({
    where: { userId }
  }).catch(() => null);

  activeTyping.forEach(item => {
    if (isValidId(item.conversationId)) {
      ns.to(room(CONVERSATION_ROOM_PREFIX, item.conversationId)).emit('typing:indicator', {
        conversationId: item.conversationId,
        userId,
        isTyping: false,
        timestamp: new Date().toISOString()
      });
    }
  });
}

async function emitPresenceToUserConversations(ns: Namespace, userId: string, isOnline: boolean) {
  const convs = await prisma.conversationParticipant.findMany({
    where: { userId },
    select: { conversationId: true }
  }).catch(() => []);

  const payload = {
    userId,
    isOnline,
    lastSeen: isOnline ? null : new Date().toISOString(),
    timestamp: new Date().toISOString()
  };

  convs.forEach(cp => {
    if (isValidId(cp.conversationId)) {
      ns.to(room(CONVERSATION_ROOM_PREFIX, cp.conversationId)).emit('presence:update', payload);
    }
  });
}

async function getMessageWithConversation(messageId: string) {
  if (!isValidId(messageId)) return null;

  return prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      conversationId: true,
      senderId: true,
      deletedAt: true,
      payment: true,
      poll: true
    }
  }).catch(() => null);
}

function sanitizePoll(rawPoll: any) {
  const poll = JSON.parse(JSON.stringify(rawPoll || {}));

  poll.options = Array.isArray(poll.options)
    ? poll.options.map((option: any) => ({
        ...option,
        votes: Array.isArray(option.votes) ? option.votes.filter((id: any) => typeof id === 'string') : []
      }))
    : [];

  poll.allowMultiple = Boolean(poll.allowMultiple);
  poll.updatedAt = new Date().toISOString();

  return poll;
}

export function initDMSockets(io: Server) {
  const ns = io.of('/dm');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, getJWTSecret()) as DMAuthPayload;
      const userId = decoded?.userId || decoded?.id;

      if (!isValidId(userId)) return next(new Error('Invalid authentication token'));

      const user = await getActiveUser(userId, decoded.role);
      if (!user) return next(new Error('User blocked or not found'));

      (socket.data as SocketUserData).userId = user.id;
      (socket.data as SocketUserData).role = user.role;

      return next();
    } catch {
      return next(new Error('Authentication required'));
    }
  });

  ns.on('connection', async (socket: Socket) => {
    const socketUser = getSocketUser(socket);
    const userId = socketUser.userId;
    const role = socketUser.role || null;

    if (!isValidId(userId)) {
      socket.disconnect(true);
      return;
    }

    bindRateLimit(socket);

    socket.join(room(USER_ROOM_PREFIX, userId));
    connectedSockets.set(userId, (connectedSockets.get(userId) || 0) + 1);

    socket.emit('dm:connected', {
      userId,
      role,
      socketId: socket.id,
      connectedAt: new Date().toISOString()
    });

    await emitPresenceToUserConversations(ns, userId, true).catch(() => null);

    socket.on('conversation:join', async ({ conversationId }: ConversationPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId)) return safeAck(ack, { success: false, error: 'Valid conversationId is required' });

        const validConversationId = conversationId;
        const participant = await isParticipant(validConversationId, userId);
        if (!participant && !isAdminRole(role)) return safeAck(ack, { success: false, error: 'Not a participant' });

        socket.join(room(CONVERSATION_ROOM_PREFIX, validConversationId));

        const unread = participant
          ? await prisma.message.count({
              where: {
                conversationId: validConversationId,
                senderId: { not: userId },
                createdAt: { gt: participant.lastReadAt || new Date(0) },
                deletedAt: null,
                ...notDeletedForUserWhere(userId)
              }
            }).catch(() => 0)
          : 0;

        socket.emit('conversation:unread', { conversationId: validConversationId, count: unread });
        safeAck(ack, { success: true, conversationId: validConversationId, unread });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to join conversation' });
      }
    });

    socket.on('conversation:leave', ({ conversationId }: ConversationPayload = {}, ack?: Ack) => {
      if (isValidId(conversationId)) socket.leave(room(CONVERSATION_ROOM_PREFIX, conversationId));
      safeAck(ack, { success: true, conversationId: conversationId || null });
    });

    socket.on('message:send', async (payload: any, ack?: Ack) => {
      try {
        if (!isValidId(payload?.conversationId)) return safeAck(ack, { success: false, error: 'Valid conversationId is required' });

        const conversationId = payload.conversationId as string;
        const allowed = await canAccessConversation(conversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        safeAck(ack, {
          success: true,
          tempId: payload.tempId || null,
          conversationId,
          acceptedAt: new Date().toISOString()
        });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Message socket acknowledgement failed' });
      }
    });

    socket.on('message:seen', async ({ messageIds, conversationId }: MessageSeenPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId) || !Array.isArray(messageIds) || messageIds.length === 0) {
          return safeAck(ack, { success: false, error: 'conversationId and messageIds are required' });
        }

        const validConversationId = conversationId;
        const participant = await isParticipant(validConversationId, userId);
        if (!participant && !isAdminRole(role)) return safeAck(ack, { success: false, error: 'Not a participant' });

        const cleanIds = [...new Set(messageIds.filter(isValidId))].slice(0, MAX_MESSAGE_SEEN_BATCH);
        if (!cleanIds.length) return safeAck(ack, { success: false, error: 'Valid messageIds are required' });

        const messages = await prisma.message.findMany({
          where: {
            id: { in: cleanIds },
            conversationId: validConversationId,
            senderId: { not: userId },
            deletedAt: null,
            ...notDeletedForUserWhere(userId)
          },
          select: {
            id: true,
            senderId: true,
            conversationId: true,
            createdAt: true
          },
          orderBy: { createdAt: 'asc' }
        });

        if (!messages.length) return safeAck(ack, { success: true, count: 0 });

        await prisma.messageRead.createMany({
          data: messages.map(message => ({
            messageId: message.id,
            userId
          })),
          skipDuplicates: true
        }).catch(() => null);

        const latest = messages[messages.length - 1];

        if (!latest) return safeAck(ack, { success: true, count: 0 });

        await prisma.conversationParticipant.update({
          where: {
            conversationId_userId: {
              conversationId: validConversationId,
              userId
            }
          },
          data: {
            lastReadMessageId: latest.id,
            lastReadAt: new Date()
          }
        }).catch(() => null);

        const readPayload = {
          conversationId: validConversationId,
          messageIds: messages.map(message => message.id),
          seenBy: userId,
          timestamp: new Date().toISOString()
        };

        const uniqueSenders = [...new Set(messages.map(message => message.senderId).filter(id => id !== userId))];

        uniqueSenders.forEach(senderId => {
          if (isValidId(senderId)) ns.to(room(USER_ROOM_PREFIX, senderId)).emit('message:seen', readPayload);
        });

        ns.to(room(CONVERSATION_ROOM_PREFIX, validConversationId)).emit('conversation:seen', {
          conversationId: validConversationId,
          userId,
          lastReadMessageId: latest.id,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, count: messages.length, lastReadMessageId: latest.id });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to mark messages as seen' });
      }
    });

    socket.on('message:reaction', async ({ messageId, emoji, remove }: ReactionPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(messageId) || !isSafeEmoji(emoji)) return safeAck(ack, { success: false, error: 'Valid messageId and emoji are required' });

        const validMessageId = messageId;
        const cleanEmoji = emoji.trim();
        const message = await getMessageWithConversation(validMessageId);

        if (!message || message.deletedAt) return safeAck(ack, { success: false, error: 'Message not found' });

        const allowed = await canAccessConversation(message.conversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        if (remove) {
          await prisma.messageReaction.deleteMany({
            where: {
              messageId: validMessageId,
              userId,
              emoji: cleanEmoji
            }
          });
        } else {
          await prisma.messageReaction.upsert({
            where: {
              messageId_userId_emoji: {
                messageId: validMessageId,
                userId,
                emoji: cleanEmoji
              }
            },
            update: {},
            create: {
              messageId: validMessageId,
              userId,
              emoji: cleanEmoji
            }
          });
        }

        const grouped = await prisma.messageReaction.groupBy({
          by: ['emoji'],
          where: { messageId: validMessageId },
          _count: { emoji: true }
        });

        const reactions = Object.fromEntries(grouped.map(item => [item.emoji, item._count.emoji]));

        ns.to(room(CONVERSATION_ROOM_PREFIX, message.conversationId)).emit('message:reaction:broadcast', {
          messageId: validMessageId,
          conversationId: message.conversationId,
          userId,
          emoji: cleanEmoji,
          removed: !!remove,
          reactions,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, reactions });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to update reaction' });
      }
    });

    socket.on('typing:start', async ({ conversationId }: ConversationPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId)) return safeAck(ack, { success: false, error: 'Valid conversationId is required' });

        const validConversationId = conversationId;
        const allowed = await canAccessConversation(validConversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
            isVerified: true
          }
        }).catch(() => null);

        await prisma.typingIndicator.upsert({
          where: {
            conversationId_userId: {
              conversationId: validConversationId,
              userId
            }
          },
          update: {
            isTyping: true,
            updatedAt: new Date()
          },
          create: {
            conversationId: validConversationId,
            userId,
            isTyping: true
          }
        }).catch(() => null);

        await emitToConversationUsers(ns, validConversationId, 'typing:indicator', {
          conversationId: validConversationId,
          userId,
          user,
          isTyping: true,
          timestamp: new Date().toISOString()
        }, userId);

        await scheduleTypingClear(ns, validConversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to start typing indicator' });
      }
    });

    socket.on('typing:stop', async ({ conversationId }: ConversationPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId)) return safeAck(ack, { success: false, error: 'Valid conversationId is required' });

        const validConversationId = conversationId;
        const allowed = await canAccessConversation(validConversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        await clearTyping(ns, validConversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to stop typing indicator' });
      }
    });

    socket.on('typing:activity', async ({ conversationId }: ConversationPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId)) return safeAck(ack, { success: false, error: 'Valid conversationId is required' });

        const validConversationId = conversationId;
        const allowed = await canAccessConversation(validConversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        await scheduleTypingClear(ns, validConversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to update typing activity' });
      }
    });

    socket.on('presence:update', async ({ isOnline }: { isOnline?: boolean } = {}, ack?: Ack) => {
      try {
        const online = Boolean(isOnline);
        await emitPresenceToUserConversations(ns, userId, online);
        safeAck(ack, { success: true, isOnline: online });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to update presence' });
      }
    });

    socket.on('call:offer', async ({ conversationId, offer, targetUserId, type }: CallPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId) || !offer || !isValidId(targetUserId)) {
          return safeAck(ack, { success: false, error: 'conversationId, offer and targetUserId are required' });
        }

        const validConversationId = conversationId;
        const validTargetUserId = targetUserId;
        const participant = await isParticipant(validConversationId, userId);
        const targetParticipant = await isParticipant(validConversationId, validTargetUserId);

        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(room(USER_ROOM_PREFIX, validTargetUserId)).emit('call:incoming', {
          from: userId,
          conversationId: validConversationId,
          offer,
          type: type === 'video' ? 'video' : 'voice',
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to send call offer' });
      }
    });

    socket.on('call:answer', async ({ conversationId, answer, targetUserId }: CallPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId) || !answer || !isValidId(targetUserId)) {
          return safeAck(ack, { success: false, error: 'conversationId, answer and targetUserId are required' });
        }

        const validConversationId = conversationId;
        const validTargetUserId = targetUserId;
        const participant = await isParticipant(validConversationId, userId);
        const targetParticipant = await isParticipant(validConversationId, validTargetUserId);

        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(room(USER_ROOM_PREFIX, validTargetUserId)).emit('call:accepted', {
          from: userId,
          conversationId: validConversationId,
          answer,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to send call answer' });
      }
    });

    socket.on('call:ice-candidate', async ({ conversationId, candidate, targetUserId }: CallPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId) || !candidate || !isValidId(targetUserId)) {
          return safeAck(ack, { success: false, error: 'conversationId, candidate and targetUserId are required' });
        }

        const validConversationId = conversationId;
        const validTargetUserId = targetUserId;
        const participant = await isParticipant(validConversationId, userId);
        const targetParticipant = await isParticipant(validConversationId, validTargetUserId);

        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(room(USER_ROOM_PREFIX, validTargetUserId)).emit('call:ice-candidate', {
          from: userId,
          conversationId: validConversationId,
          candidate,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to send ICE candidate' });
      }
    });

    socket.on('call:end', async ({ conversationId, targetUserId, reason }: CallPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(conversationId) || !isValidId(targetUserId)) {
          return safeAck(ack, { success: false, error: 'conversationId and targetUserId are required' });
        }

        const validConversationId = conversationId;
        const validTargetUserId = targetUserId;
        const participant = await isParticipant(validConversationId, userId);
        const targetParticipant = await isParticipant(validConversationId, validTargetUserId);

        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(room(USER_ROOM_PREFIX, validTargetUserId)).emit('call:ended', {
          from: userId,
          conversationId: validConversationId,
          reason: reason || 'ended',
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to end call' });
      }
    });

    socket.on('payment:initiate', async ({ conversationId, amount, recipientId }: PaymentInitiatePayload = {}, ack?: Ack) => {
      try {
        const coinAmount = normalizeAmount(amount);

        if (!isValidId(conversationId) || !isValidId(recipientId) || coinAmount <= 0 || coinAmount > MAX_PAYMENT_AMOUNT) {
          return safeAck(ack, { success: false, error: 'Valid conversationId, recipientId and amount are required' });
        }

        const validConversationId = conversationId;
        const validRecipientId = recipientId;

        if (validRecipientId === userId) return safeAck(ack, { success: false, error: 'Cannot send coins to yourself' });

        const senderParticipant = await isParticipant(validConversationId, userId);
        const receiverParticipant = await isParticipant(validConversationId, validRecipientId);

        if (!senderParticipant || !receiverParticipant) return safeAck(ack, { success: false, error: 'Invalid payment participants' });

        const sender = await prisma.user.findUnique({
          where: { id: userId },
          select: { coins: true }
        });

        if (!sender || sender.coins < coinAmount) {
          return safeAck(ack, { success: false, error: 'Insufficient coins' });
        }

        const message = await prisma.message.create({
          data: {
            conversationId: validConversationId,
            senderId: userId,
            content: `Sent ${coinAmount} coins`,
            payment: {
              amount: coinAmount,
              currency: 'TEXA_COIN',
              status: 'pending',
              recipientId: validRecipientId,
              createdAt: new Date().toISOString()
            },
            status: MsgStatus.SENT
          },
          include: {
            sender: {
              select: {
                id: true,
                username: true,
                avatarUrl: true,
                isVerified: true
              }
            }
          }
        });

        await prisma.conversation.update({
          where: { id: validConversationId },
          data: {
            lastMessageId: message.id,
            updatedAt: new Date()
          }
        }).catch(() => null);

        ns.to(room(CONVERSATION_ROOM_PREFIX, validConversationId)).emit('message:new', message);
        ns.to(room(USER_ROOM_PREFIX, validRecipientId)).emit('payment:incoming', {
          messageId: message.id,
          conversationId: validConversationId,
          amount: coinAmount,
          from: userId,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, messageId: message.id, status: 'pending' });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to initiate payment' });
      }
    });

    socket.on('payment:confirm', async ({ messageId }: PaymentConfirmPayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(messageId)) return safeAck(ack, { success: false, error: 'Valid messageId is required' });

        const validMessageId = messageId;
        const message = await prisma.message.findUnique({
          where: { id: validMessageId }
        });

        const payment = (message as any)?.payment;

        if (!message || !payment || payment.status !== 'pending') {
          return safeAck(ack, { success: false, error: 'Invalid pending payment' });
        }

        if (payment.recipientId !== userId) {
          return safeAck(ack, { success: false, error: 'Only recipient can confirm this payment' });
        }

        const amount = normalizeAmount(payment.amount);

        if (amount <= 0 || amount > MAX_PAYMENT_AMOUNT) {
          return safeAck(ack, { success: false, error: 'Invalid payment amount' });
        }

        await prisma.$transaction(async tx => {
          const latestMessage = await tx.message.findUnique({
            where: { id: validMessageId }
          });

          const latestPayment = (latestMessage as any)?.payment;

          if (!latestMessage || !latestPayment || latestPayment.status !== 'pending') {
            throw new Error('Payment already processed');
          }

          const sender = await tx.user.findUnique({
            where: { id: latestMessage.senderId },
            select: { coins: true }
          });

          if (!sender || sender.coins < amount) throw new Error('Sender has insufficient coins');

          await tx.user.update({
            where: { id: latestMessage.senderId },
            data: {
              coins: {
                decrement: amount
              }
            }
          });

          await tx.user.update({
            where: { id: latestPayment.recipientId },
            data: {
              coins: {
                increment: amount
              }
            }
          });

          await tx.message.update({
            where: { id: validMessageId },
            data: {
              payment: {
                ...latestPayment,
                status: 'completed',
                completedAt: new Date().toISOString()
              }
            }
          });
        });

        ns.to(room(CONVERSATION_ROOM_PREFIX, message.conversationId)).emit('payment:completed', {
          messageId: validMessageId,
          conversationId: message.conversationId,
          amount,
          senderId: message.senderId,
          recipientId: payment.recipientId,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, status: 'completed' });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to confirm payment' });
      }
    });

    socket.on('poll:vote', async ({ messageId, optionIndex }: PollVotePayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(messageId) || typeof optionIndex !== 'number') {
          return safeAck(ack, { success: false, error: 'Valid messageId and optionIndex are required' });
        }

        const validMessageId = messageId;
        const message = await getMessageWithConversation(validMessageId);

        if (!message || !message.poll) return safeAck(ack, { success: false, error: 'Poll not found' });

        const allowed = await canAccessConversation(message.conversationId, userId, role);
        if (!allowed) return safeAck(ack, { success: false, error: 'Not a participant' });

        const poll = sanitizePoll(message.poll);

        if (!poll.options[optionIndex]) {
          return safeAck(ack, { success: false, error: 'Invalid poll option' });
        }

        const existingIndex = poll.options[optionIndex].votes.indexOf(userId);

        if (existingIndex >= 0) {
          poll.options[optionIndex].votes.splice(existingIndex, 1);
        } else if (poll.allowMultiple) {
          poll.options[optionIndex].votes.push(userId);
        } else {
          poll.options.forEach((option: any) => {
            option.votes = option.votes.filter((id: string) => id !== userId);
          });
          poll.options[optionIndex].votes.push(userId);
        }

        await prisma.message.update({
          where: { id: validMessageId },
          data: { poll }
        });

        ns.to(room(CONVERSATION_ROOM_PREFIX, message.conversationId)).emit('poll:updated', {
          messageId: validMessageId,
          conversationId: message.conversationId,
          poll,
          votedBy: userId,
          optionIndex,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, poll });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to vote on poll' });
      }
    });

    socket.on('disappearing:set', async ({ messageId, seconds }: DisappearingPayload = {}, ack?: Ack) => {
      try {
        const ttl = normalizeAmount(seconds);

        if (!isValidId(messageId) || ttl <= 0 || ttl > MAX_DISAPPEARING_SECONDS) {
          return safeAck(ack, { success: false, error: 'Valid messageId and seconds are required' });
        }

        const validMessageId = messageId;
        const message = await prisma.message.findUnique({
          where: { id: validMessageId },
          select: {
            id: true,
            conversationId: true,
            senderId: true
          }
        });

        if (!message) return safeAck(ack, { success: false, error: 'Message not found' });

        const participant = await isParticipant(message.conversationId, userId);
        if (!participant && !isAdminRole(role)) return safeAck(ack, { success: false, error: 'Not a participant' });

        if (message.senderId !== userId && !isAdminRole(role) && participant?.role !== 'admin') {
          return safeAck(ack, { success: false, error: 'Cannot update disappearing timer for this message' });
        }

        const expiresAt = new Date(Date.now() + ttl * 1000);

        await prisma.message.update({
          where: { id: validMessageId },
          data: { expiresAt }
        });

        ns.to(room(CONVERSATION_ROOM_PREFIX, message.conversationId)).emit('disappearing:updated', {
          messageId: validMessageId,
          conversationId: message.conversationId,
          expiresAt: expiresAt.toISOString()
        });

        safeAck(ack, { success: true, expiresAt: expiresAt.toISOString() });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to set disappearing timer' });
      }
    });

    socket.on('folder:update', async ({ folderId, conversationIds }: FolderUpdatePayload = {}, ack?: Ack) => {
      try {
        if (!isValidId(folderId) || !Array.isArray(conversationIds)) {
          return safeAck(ack, { success: false, error: 'folderId and conversationIds are required' });
        }

        const validFolderId = folderId;
        const cleanConversationIds = [...new Set(conversationIds.filter(isValidId))].slice(0, 200);

        const folder = await prisma.chatFolder.findFirst({
          where: {
            id: validFolderId,
            userId
          },
          select: { id: true }
        });

        if (!folder) return safeAck(ack, { success: false, error: 'Folder not found' });

        const allowed = await prisma.conversationParticipant.findMany({
          where: {
            userId,
            conversationId: { in: cleanConversationIds }
          },
          select: { conversationId: true }
        });

        const allowedIds = allowed.map(item => item.conversationId).filter(isValidId);

        const updated = await prisma.chatFolder.update({
          where: { id: validFolderId },
          data: {
            conversationIds: allowedIds
          }
        });

        socket.emit('folder:updated', {
          folderId: validFolderId,
          conversationIds: updated.conversationIds || allowedIds
        });

        safeAck(ack, { success: true, folder: updated });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error?.message || 'Failed to update folder' });
      }
    });

    socket.on('disconnect', async () => {
      try {
        socketBuckets.delete(socket.id);

        const count = Math.max((connectedSockets.get(userId) || 1) - 1, 0);

        if (count <= 0) {
          connectedSockets.delete(userId);
          await clearAllTypingForUser(ns, userId);
          await emitPresenceToUserConversations(ns, userId, false);
        } else {
          connectedSockets.set(userId, count);
        }
      } catch {}
    });
  });

  return ns;
}

export function emitDMMessage(io: Server, conversationId: string, message: any) {
  if (!isValidId(conversationId)) return;

  const ns = io.of('/dm');
  ns.to(room(CONVERSATION_ROOM_PREFIX, conversationId)).emit('message:new', message);

  getConversationParticipantIds(conversationId)
    .then(userIds => {
      userIds.forEach(userId => {
        if (userId !== message?.senderId) {
          ns.to(room(USER_ROOM_PREFIX, userId)).emit('message:new', message);
        }
      });
    })
    .catch(() => null);
}

export function emitDMMessageUpdated(io: Server, conversationId: string, message: any) {
  if (!isValidId(conversationId)) return;

  io.of('/dm').to(room(CONVERSATION_ROOM_PREFIX, conversationId)).emit('message:updated', {
    conversationId,
    message,
    timestamp: new Date().toISOString()
  });
}

export function emitDMMessageDeleted(io: Server, conversationId: string, messageId: string, deletedBy?: string) {
  if (!isValidId(conversationId) || !isValidId(messageId)) return;

  io.of('/dm').to(room(CONVERSATION_ROOM_PREFIX, conversationId)).emit('message:deleted', {
    conversationId,
    messageId,
    deletedBy: deletedBy || null,
    timestamp: new Date().toISOString()
  });
}

export function emitConversationUpdated(io: Server, conversationId: string, payload: any) {
  if (!isValidId(conversationId)) return;

  io.of('/dm').to(room(CONVERSATION_ROOM_PREFIX, conversationId)).emit('conversation:updated', {
    conversationId,
    ...payload,
    timestamp: new Date().toISOString()
  });
}

export function emitDMToUser(io: Server, userId: string, event: string, payload: any) {
  if (!isValidId(userId) || !event) return;

  io.of('/dm').to(room(USER_ROOM_PREFIX, userId)).emit(event, {
    ...(payload && typeof payload === 'object' ? payload : { data: payload }),
    timestamp: new Date().toISOString()
  });
}

export function getDMRoom(type: 'user' | 'conversation', id: string) {
  return type === 'user' ? room(USER_ROOM_PREFIX, id) : room(CONVERSATION_ROOM_PREFIX, id);
}
