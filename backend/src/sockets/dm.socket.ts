import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';

type DMAuthPayload = {
  userId: string;
  role: string;
};

type Ack<T = any> = (response: T) => void;

const typingTimers = new Map<string, NodeJS.Timeout>();
const connectedSockets = new Map<string, number>();

function safeAck(ack: Ack | undefined, response: any) {
  if (typeof ack === 'function') ack(response);
}

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const headerToken = socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, '');
  return authToken || headerToken;
}

async function isParticipant(conversationId: string, userId: string) {
  return prisma.conversationParticipant.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId
      }
    }
  });
}

async function getConversationParticipantIds(conversationId: string) {
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true }
  });
  return participants.map(p => p.userId);
}

async function emitToConversationUsers(ns: ReturnType<Server['of']>, conversationId: string, event: string, payload: any, excludeUserId?: string) {
  const userIds = await getConversationParticipantIds(conversationId);
  userIds.forEach(id => {
    if (id !== excludeUserId) ns.to(`user:${id}`).emit(event, payload);
  });
  ns.to(`conv:${conversationId}`).emit(event, payload);
}

async function clearTyping(ns: ReturnType<Server['of']>, conversationId: string, userId: string) {
  const key = `${conversationId}:${userId}`;
  const timer = typingTimers.get(key);
  if (timer) clearTimeout(timer);
  typingTimers.delete(key);
  await prisma.typingIndicator.deleteMany({
    where: {
      conversationId,
      userId
    }
  });
  await emitToConversationUsers(ns, conversationId, 'typing:indicator', {
    conversationId,
    userId,
    isTyping: false
  }, userId);
}

async function scheduleTypingClear(ns: ReturnType<Server['of']>, conversationId: string, userId: string) {
  const key = `${conversationId}:${userId}`;
  const oldTimer = typingTimers.get(key);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    clearTyping(ns, conversationId, userId).catch(() => {});
  }, 5000);
  typingTimers.set(key, timer);
}

export function initDMSockets(io: Server) {
  const ns = io.of('/dm');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as DMAuthPayload;
      if (!decoded?.userId) return next(new Error('Invalid authentication token'));
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  ns.on('connection', async (socket: Socket) => {
    const userId = socket.data.userId as string;

    socket.join(`user:${userId}`);
    connectedSockets.set(userId, (connectedSockets.get(userId) || 0) + 1);

    socket.on('conversation:join', async ({ conversationId }, ack?: Ack) => {
      try {
        if (!conversationId) return safeAck(ack, { success: false, error: 'conversationId is required' });

        const participant = await isParticipant(conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        socket.join(`conv:${conversationId}`);

        const unread = await prisma.message.count({
          where: {
            conversationId,
            senderId: { not: userId },
            createdAt: { gt: participant.lastReadAt || new Date(0) },
            deletedAt: null,
            deletedFor: { not: { has: userId } }
          }
        });

        socket.emit('conversation:unread', { conversationId, count: unread });
        safeAck(ack, { success: true, conversationId, unread });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to join conversation' });
      }
    });

    socket.on('conversation:leave', ({ conversationId }, ack?: Ack) => {
      if (conversationId) socket.leave(`conv:${conversationId}`);
      safeAck(ack, { success: true, conversationId });
    });

    socket.on('message:send', async (payload: any, ack?: Ack) => {
      try {
        if (!payload?.conversationId) return safeAck(ack, { success: false, error: 'conversationId is required' });

        const participant = await isParticipant(payload.conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        safeAck(ack, {
          success: true,
          tempId: payload.tempId || null,
          conversationId: payload.conversationId,
          acceptedAt: new Date().toISOString()
        });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Message socket acknowledgement failed' });
      }
    });

    socket.on('message:seen', async ({ messageIds, conversationId }, ack?: Ack) => {
      try {
        if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) {
          return safeAck(ack, { success: false, error: 'conversationId and messageIds are required' });
        }

        const participant = await isParticipant(conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        const messages = await prisma.message.findMany({
          where: {
            id: { in: messageIds },
            conversationId,
            senderId: { not: userId },
            deletedAt: null,
            deletedFor: { not: { has: userId } }
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
        });

        const latest = messages[messages.length - 1];

        await prisma.conversationParticipant.update({
          where: {
            conversationId_userId: {
              conversationId,
              userId
            }
          },
          data: {
            lastReadMessageId: latest.id,
            lastReadAt: new Date()
          }
        });

        const uniqueSenders = [...new Set(messages.map(message => message.senderId).filter(id => id !== userId))];

        uniqueSenders.forEach(senderId => {
          ns.to(`user:${senderId}`).emit('message:seen', {
            conversationId,
            messageIds: messages.map(message => message.id),
            seenBy: userId,
            timestamp: new Date().toISOString()
          });
        });

        ns.to(`conv:${conversationId}`).emit('conversation:seen', {
          conversationId,
          userId,
          lastReadMessageId: latest.id,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, count: messages.length, lastReadMessageId: latest.id });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to mark messages as seen' });
      }
    });

    socket.on('message:reaction', async ({ messageId, emoji, remove }, ack?: Ack) => {
      try {
        if (!messageId || !emoji) return safeAck(ack, { success: false, error: 'messageId and emoji are required' });

        const message = await prisma.message.findUnique({
          where: { id: messageId },
          select: { id: true, conversationId: true }
        });

        if (!message) return safeAck(ack, { success: false, error: 'Message not found' });

        const participant = await isParticipant(message.conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        if (remove) {
          await prisma.messageReaction.deleteMany({
            where: {
              messageId,
              userId,
              emoji
            }
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

        const grouped = await prisma.messageReaction.groupBy({
          by: ['emoji'],
          where: { messageId },
          _count: { emoji: true }
        });

        const reactions = Object.fromEntries(grouped.map(item => [item.emoji, item._count.emoji]));

        ns.to(`conv:${message.conversationId}`).emit('message:reaction:broadcast', {
          messageId,
          conversationId: message.conversationId,
          userId,
          emoji,
          removed: !!remove,
          reactions,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, reactions });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to update reaction' });
      }
    });

    socket.on('typing:start', async ({ conversationId }, ack?: Ack) => {
      try {
        if (!conversationId) return safeAck(ack, { success: false, error: 'conversationId is required' });

        const participant = await isParticipant(conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true
          }
        });

        await prisma.typingIndicator.upsert({
          where: {
            conversationId_userId: {
              conversationId,
              userId
            }
          },
          update: {
            isTyping: true,
            updatedAt: new Date()
          },
          create: {
            conversationId,
            userId,
            isTyping: true
          }
        });

        await emitToConversationUsers(ns, conversationId, 'typing:indicator', {
          conversationId,
          userId,
          user,
          isTyping: true,
          timestamp: new Date().toISOString()
        }, userId);

        await scheduleTypingClear(ns, conversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to start typing indicator' });
      }
    });

    socket.on('typing:stop', async ({ conversationId }, ack?: Ack) => {
      try {
        if (!conversationId) return safeAck(ack, { success: false, error: 'conversationId is required' });

        const participant = await isParticipant(conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        await clearTyping(ns, conversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to stop typing indicator' });
      }
    });

    socket.on('typing:activity', async ({ conversationId }, ack?: Ack) => {
      try {
        if (!conversationId) return safeAck(ack, { success: false, error: 'conversationId is required' });

        const participant = await isParticipant(conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        await scheduleTypingClear(ns, conversationId, userId);
        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to update typing activity' });
      }
    });

    socket.on('presence:update', async ({ isOnline }, ack?: Ack) => {
      try {
        const online = Boolean(isOnline);
        const convs = await prisma.conversationParticipant.findMany({
          where: { userId },
          select: { conversationId: true }
        });

        convs.forEach(cp => {
          ns.to(`conv:${cp.conversationId}`).emit('presence:update', {
            userId,
            isOnline: online,
            lastSeen: online ? null : new Date().toISOString()
          });
        });

        safeAck(ack, { success: true, isOnline: online });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to update presence' });
      }
    });

    socket.on('call:offer', async ({ conversationId, offer, targetUserId, type }, ack?: Ack) => {
      try {
        if (!conversationId || !offer || !targetUserId) return safeAck(ack, { success: false, error: 'conversationId, offer and targetUserId are required' });

        const participant = await isParticipant(conversationId, userId);
        const targetParticipant = await isParticipant(conversationId, targetUserId);
        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(`user:${targetUserId}`).emit('call:incoming', {
          from: userId,
          conversationId,
          offer,
          type: type === 'video' ? 'video' : 'voice',
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to send call offer' });
      }
    });

    socket.on('call:answer', async ({ conversationId, answer, targetUserId }, ack?: Ack) => {
      try {
        if (!conversationId || !answer || !targetUserId) return safeAck(ack, { success: false, error: 'conversationId, answer and targetUserId are required' });

        const participant = await isParticipant(conversationId, userId);
        const targetParticipant = await isParticipant(conversationId, targetUserId);
        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(`user:${targetUserId}`).emit('call:accepted', {
          from: userId,
          conversationId,
          answer,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to send call answer' });
      }
    });

    socket.on('call:ice-candidate', async ({ conversationId, candidate, targetUserId }, ack?: Ack) => {
      try {
        if (!conversationId || !candidate || !targetUserId) return safeAck(ack, { success: false, error: 'conversationId, candidate and targetUserId are required' });

        const participant = await isParticipant(conversationId, userId);
        const targetParticipant = await isParticipant(conversationId, targetUserId);
        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(`user:${targetUserId}`).emit('call:ice-candidate', {
          from: userId,
          conversationId,
          candidate,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to send ICE candidate' });
      }
    });

    socket.on('call:end', async ({ conversationId, targetUserId, reason }, ack?: Ack) => {
      try {
        if (!conversationId || !targetUserId) return safeAck(ack, { success: false, error: 'conversationId and targetUserId are required' });

        const participant = await isParticipant(conversationId, userId);
        const targetParticipant = await isParticipant(conversationId, targetUserId);
        if (!participant || !targetParticipant) return safeAck(ack, { success: false, error: 'Invalid call participants' });

        ns.to(`user:${targetUserId}`).emit('call:ended', {
          from: userId,
          conversationId,
          reason: reason || 'ended',
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to end call' });
      }
    });

    socket.on('payment:initiate', async ({ conversationId, amount, recipientId }, ack?: Ack) => {
      try {
        const coinAmount = Number(amount);

        if (!conversationId || !recipientId || !Number.isInteger(coinAmount) || coinAmount <= 0) {
          return safeAck(ack, { success: false, error: 'Valid conversationId, recipientId and amount are required' });
        }

        const senderParticipant = await isParticipant(conversationId, userId);
        const receiverParticipant = await isParticipant(conversationId, recipientId);
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
            conversationId,
            senderId: userId,
            content: `Sent ${coinAmount} coins`,
            payment: {
              amount: coinAmount,
              currency: 'TEXA_COIN',
              status: 'pending',
              recipientId
            },
            status: 'DELIVERED'
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
          where: { id: conversationId },
          data: {
            lastMessageId: message.id,
            updatedAt: new Date()
          }
        });

        ns.to(`conv:${conversationId}`).emit('message:new', message);
        ns.to(`user:${recipientId}`).emit('payment:incoming', {
          messageId: message.id,
          conversationId,
          amount: coinAmount,
          from: userId
        });

        safeAck(ack, { success: true, messageId: message.id, status: 'pending' });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to initiate payment' });
      }
    });

    socket.on('payment:confirm', async ({ messageId }, ack?: Ack) => {
      try {
        if (!messageId) return safeAck(ack, { success: false, error: 'messageId is required' });

        const message = await prisma.message.findUnique({
          where: { id: messageId }
        });

        const payment = message?.payment as any;

        if (!message || !payment || payment.status !== 'pending') {
          return safeAck(ack, { success: false, error: 'Invalid pending payment' });
        }

        if (payment.recipientId !== userId) {
          return safeAck(ack, { success: false, error: 'Only recipient can confirm this payment' });
        }

        const amount = Number(payment.amount);
        if (!Number.isInteger(amount) || amount <= 0) {
          return safeAck(ack, { success: false, error: 'Invalid payment amount' });
        }

        await prisma.$transaction(async tx => {
          const sender = await tx.user.findUnique({
            where: { id: message.senderId },
            select: { coins: true }
          });

          if (!sender || sender.coins < amount) throw new Error('Sender has insufficient coins');

          await tx.user.update({
            where: { id: message.senderId },
            data: {
              coins: {
                decrement: amount
              }
            }
          });

          await tx.user.update({
            where: { id: payment.recipientId },
            data: {
              coins: {
                increment: amount
              }
            }
          });

          await tx.message.update({
            where: { id: messageId },
            data: {
              payment: {
                ...payment,
                status: 'completed',
                completedAt: new Date().toISOString()
              }
            }
          });
        });

        ns.to(`conv:${message.conversationId}`).emit('payment:completed', {
          messageId,
          conversationId: message.conversationId,
          amount,
          senderId: message.senderId,
          recipientId: payment.recipientId,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, status: 'completed' });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to confirm payment' });
      }
    });

    socket.on('poll:vote', async ({ messageId, optionIndex }, ack?: Ack) => {
      try {
        if (!messageId || typeof optionIndex !== 'number') {
          return safeAck(ack, { success: false, error: 'messageId and optionIndex are required' });
        }

        const message = await prisma.message.findUnique({
          where: { id: messageId }
        });

        if (!message?.poll) return safeAck(ack, { success: false, error: 'Poll not found' });

        const participant = await isParticipant(message.conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        const poll = JSON.parse(JSON.stringify(message.poll));

        if (!Array.isArray(poll.options) || !poll.options[optionIndex]) {
          return safeAck(ack, { success: false, error: 'Invalid poll option' });
        }

        poll.options = poll.options.map((option: any) => ({
          ...option,
          votes: Array.isArray(option.votes) ? option.votes : []
        }));

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

        poll.updatedAt = new Date().toISOString();

        await prisma.message.update({
          where: { id: messageId },
          data: { poll }
        });

        ns.to(`conv:${message.conversationId}`).emit('poll:updated', {
          messageId,
          conversationId: message.conversationId,
          poll,
          votedBy: userId,
          optionIndex,
          timestamp: new Date().toISOString()
        });

        safeAck(ack, { success: true, poll });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to vote on poll' });
      }
    });

    socket.on('disappearing:set', async ({ messageId, seconds }, ack?: Ack) => {
      try {
        const ttl = Number(seconds);
        if (!messageId || !Number.isInteger(ttl) || ttl <= 0) {
          return safeAck(ack, { success: false, error: 'Valid messageId and seconds are required' });
        }

        const message = await prisma.message.findUnique({
          where: { id: messageId },
          select: {
            id: true,
            conversationId: true,
            senderId: true
          }
        });

        if (!message) return safeAck(ack, { success: false, error: 'Message not found' });

        const participant = await isParticipant(message.conversationId, userId);
        if (!participant) return safeAck(ack, { success: false, error: 'Not a participant' });

        if (message.senderId !== userId && participant.role !== 'admin') {
          return safeAck(ack, { success: false, error: 'Cannot update disappearing timer for this message' });
        }

        const expiresAt = new Date(Date.now() + ttl * 1000);

        await prisma.message.update({
          where: { id: messageId },
          data: { expiresAt }
        });

        ns.to(`conv:${message.conversationId}`).emit('disappearing:updated', {
          messageId,
          conversationId: message.conversationId,
          expiresAt: expiresAt.toISOString()
        });

        safeAck(ack, { success: true, expiresAt: expiresAt.toISOString() });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to set disappearing timer' });
      }
    });

    socket.on('folder:update', async ({ folderId, conversationIds }, ack?: Ack) => {
      try {
        if (!folderId || !Array.isArray(conversationIds)) {
          return safeAck(ack, { success: false, error: 'folderId and conversationIds are required' });
        }

        const folder = await prisma.chatFolder.findFirst({
          where: {
            id: folderId,
            userId
          },
          select: { id: true }
        });

        if (!folder) return safeAck(ack, { success: false, error: 'Folder not found' });

        const allowed = await prisma.conversationParticipant.findMany({
          where: {
            userId,
            conversationId: { in: conversationIds }
          },
          select: { conversationId: true }
        });

        const allowedIds = allowed.map(item => item.conversationId);

        const updated = await prisma.chatFolder.update({
          where: { id: folderId },
          data: {
            conversationIds: allowedIds
          }
        });

        socket.emit('folder:updated', {
          folderId,
          conversationIds: updated.conversationIds
        });

        safeAck(ack, { success: true, folder: updated });
      } catch (error: any) {
        safeAck(ack, { success: false, error: error.message || 'Failed to update folder' });
      }
    });

    socket.on('disconnect', async () => {
      try {
        const count = Math.max((connectedSockets.get(userId) || 1) - 1, 0);

        if (count <= 0) {
          connectedSockets.delete(userId);
          await prisma.typingIndicator.deleteMany({ where: { userId } });

          const convs = await prisma.conversationParticipant.findMany({
            where: { userId },
            select: { conversationId: true }
          });

          convs.forEach(cp => {
            ns.to(`conv:${cp.conversationId}`).emit('presence:update', {
              userId,
              isOnline: false,
              lastSeen: new Date().toISOString()
            });
          });

          [...typingTimers.keys()].forEach(key => {
            if (key.endsWith(`:${userId}`)) {
              const timer = typingTimers.get(key);
              if (timer) clearTimeout(timer);
              typingTimers.delete(key);
            }
          });
        } else {
          connectedSockets.set(userId, count);
        }
      } catch {}
    });
  });
}
