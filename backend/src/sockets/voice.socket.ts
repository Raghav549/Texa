import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';

export function initVoiceSockets(io: Server) {
  const ns = io.of('/voice');
  ns.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch { next(new Error('Auth required')); }
  });

  ns.on('connection', (socket: Socket) => {
    let currentRoom: string | null = null;

    socket.on('room:join', async ({ roomId }) => {
      currentRoom = roomId;
      socket.join(roomId);
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: { select: { id: true, username: true, isVerified: true, avatarUrl: true } } } } } });
      if (room?.isActive) socket.emit('room:sync', room);
    });

    socket.on('seat:take', async () => {
      if (!currentRoom) return;
      const occupied = await prisma.seat.count({ where: { roomId: currentRoom } });
      if (occupied >= 10) return socket.emit('error', 'Room full');
      await prisma.seat.create({ data: { roomId: currentRoom, userId: socket.data.userId } });
      await syncRoom(currentRoom);
    });

    socket.on('seat:leave', async () => {
      if (!currentRoom) return;
      await prisma.seat.deleteMany({ where: { roomId: currentRoom, userId: socket.data.userId } });
      await syncRoom(currentRoom);
    });

    socket.on('seat:mic', async ({ isMuted, handRaised }) => {
      if (!currentRoom) return;
      await prisma.seat.updateMany({ where: { roomId: currentRoom, userId: socket.data.userId }, data: { isMuted, handRaised } });
      ns.to(currentRoom).emit('seat:update', { userId: socket.data.userId, isMuted, handRaised });
    });

    socket.on('music:queue:add', async ({ track }) => {
      if (!currentRoom) return;
      const room = await prisma.voiceRoom.findUnique({ where: { id: currentRoom } });
      const queue = [...(room?.musicQueue as any[] || []), track];
      await prisma.voiceRoom.update({ where: { id: currentRoom },  { musicQueue: queue } });
      ns.to(currentRoom).emit('queue:update', queue);
    });

    socket.on('music:play', async ({ trackUrl, offsetMs }) => {
      if (!currentRoom) return;
      await prisma.voiceRoom.update({ where: { id: currentRoom },  { currentTrack: trackUrl, isPlaying: true, playStartedAt: new Date(Date.now() - offsetMs) } });
      ns.to(currentRoom).emit('music:sync', { trackUrl, offsetMs });
    });

    socket.on('music:pause', async () => {
      if (!currentRoom) return;
      await prisma.voiceRoom.update({ where: { id: currentRoom }, data: { isPlaying: false } });
      ns.to(currentRoom).emit('music:pause');
    });

    socket.on('chat:send', async ({ text }) => {
      if (!currentRoom) return;
      const msg = { userId: socket.data.userId, text, ts: Date.now() };
      ns.to(currentRoom).emit('chat:new', msg);
    });

    socket.on('gift:send', async ({ toId, type, amount }) => {
      if (!currentRoom) return;
      await prisma.$transaction([
        prisma.user.update({ where: { id: socket.data.userId },  { coins: { decrement: amount } } }),
        prisma.gift.create({  { fromId: socket.data.userId, toId, roomId: currentRoom, type, amount } })
      ]);
      ns.to(currentRoom).emit('gift:trigger', { from: socket.data.userId, to: toId, type, amount });
    });

    socket.on('disconnect', async () => {
      if (!currentRoom) return;
      await prisma.seat.deleteMany({ where: { roomId: currentRoom, userId: socket.data.userId } });
      await syncRoom(currentRoom);
      socket.leave(currentRoom);
    });

    async function syncRoom(id: string) {
      const room = await prisma.voiceRoom.findUnique({ where: { id }, include: { seats: { include: { user: { select: { id: true, username: true, isVerified: true, avatarUrl: true, isMuted: true, handRaised: true } } } } } });
      ns.to(id).emit('room:sync', room);
    }
  });
}
