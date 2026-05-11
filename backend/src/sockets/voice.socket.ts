import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';

export function initVoiceSockets(io: Server) {
  const ns = io.of('/voice');
  ns.use((socket, next) => {
    const token = socket.handshake.auth.token;
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { userId: string, role: string };
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      next();
    } catch { next(new Error('Auth required')); }
  });

  ns.on('connection', (socket: Socket) => {
    let roomId: string | null = null;

    socket.on('room:join', async ({ roomId: rId }) => {
      roomId = rId;
      socket.join(roomId);
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } } } } } });
      socket.emit('room:sync', room);
    });

    socket.on('seat:take', async () => {
      if (!roomId) return;
      const taken = await prisma.seat.count({ where: { roomId } });
      if (taken >= 10) return socket.emit('error', 'Room full');
      await prisma.seat.create({ data: { roomId, userId: socket.data.userId } });
      await syncRoom(roomId);
    });

    socket.on('seat:leave', async () => { await removeSeat(socket); });
    socket.on('disconnect', async () => { await removeSeat(socket); });

    socket.on('seat:mic', async ({ isMuted }) => {
      if (!roomId) return;
      await prisma.seat.updateMany({ where: { roomId, userId: socket.data.userId }, data: { isMuted } });
      ns.to(roomId).emit('seat:mic', { userId: socket.data.userId, isMuted });
    });

    socket.on('seat:hand', async ({ raised }) => {
      if (!roomId) return;
      await prisma.seat.updateMany({ where: { roomId, userId: socket.data.userId }, data: { handRaised: raised } });
      ns.to(roomId).emit('seat:hand', { userId: socket.data.userId, handRaised: raised });
    });

    socket.on('host:action', async ({ action, targetId }) => {
      if (!roomId) return;
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
      if (room?.hostId !== socket.data.userId && socket.data.role !== 'SUPERADMIN') return socket.emit('error', 'Host/Admin only');
      if (action === 'mute') await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isMuted: true } });
      if (action === 'kick') await prisma.seat.deleteMany({ where: { roomId, userId: targetId } });
      if (action === 'promote') await prisma.seat.updateMany({ where: { roomId, userId: targetId }, data: { isMuted: false } });
      if (action === 'close') await prisma.voiceRoom.update({ where: { id: roomId }, data: { isActive: false } });
      ns.to(roomId).emit('host:action', { action, targetId });
    });

    socket.on('music:play', async ({ track, timestamp }) => {
      if (!roomId) return;
      await prisma.voiceRoom.update({ where: { id: roomId }, data: { currentTrack: track, isPlaying: true, playTimestamp: timestamp } });
      ns.to(roomId).emit('music:sync', { track, timestamp });
    });

    socket.on('music:queue', async ({ queue }) => {
      if (!roomId) return;
      await prisma.voiceRoom.update({ where: { id: roomId }, data: { musicQueue: queue } });
      ns.to(roomId).emit('queue:update', queue);
    });

    socket.on('gift:send', async ({ toId, type, amount }) => {
      if (!roomId) return;
      await prisma.$transaction([
        prisma.user.update({ where: { id: socket.data.userId }, data: { coins: { decrement: amount } } }),
        prisma.gift.create({ data: { fromId: socket.data.userId, toId, roomId, type, amount } })
      ]);
      ns.to(roomId).emit('gift:trigger', { from: socket.data.userId, to: toId, type, amount });
    });

    socket.on('chat:send', async ({ text }) => {
      if (!roomId) return;
      const msg = { userId: socket.data.userId, text, ts: Date.now() };
      await prisma.voiceRoom.update({ where: { id: roomId }, data: { chatMessages: { push: msg } } });
      ns.to(roomId).emit('chat:new', msg);
    });
  });

  async function removeSeat(socket: Socket) {
    if (!roomId) return;
    await prisma.seat.deleteMany({ where: { roomId, userId: socket.data.userId } });
    await syncRoom(roomId);
  }
  async function syncRoom(id: string) {
    const room = await prisma.voiceRoom.findUnique({ where: { id }, include: { seats: { include: { user: { select: { id: true, username: true, avatarUrl: true, isVerified: true, isMuted: true, handRaised: true } } } } } });
    ns.to(id).emit('room:sync', room);
  }
}
