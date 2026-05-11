import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';

export function initVoiceSockets(io: Server) {
  const ns = io.of('/voice');
  ns.on('connection', (socket: Socket) => {
    const roomId = socket.handshake.query.roomId as string;
    if (!roomId) return socket.disconnect();

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = (socket.request as any).userId;

    const sync = async () => {
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } } } } } });
      ns.to(roomId).emit('room:sync', room);
    };

    socket.on('seat:take', async () => {
      const taken = await prisma.seat.count({ where: { roomId } });
      if (taken >= 10) return socket.emit('error', 'Room full');
      await prisma.seat.create({ data: { roomId, userId: socket.data.userId } });
      await sync();
    });

    socket.on('seat:leave', async () => {
      await prisma.seat.deleteMany({ where: { roomId, userId: socket.data.userId } });
      await sync();
    });

    socket.on('seat:mic', async ({ isMuted }) => {
      await prisma.seat.updateMany({ where: { roomId, userId: socket.data.userId },  { isMuted } });
      ns.to(roomId).emit('seat:mic', { userId: socket.data.userId, isMuted });
    });

    socket.on('chat:send', async ({ text }) => {
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
      const chat = [...(room?.chatMessages as any[] || []), { userId: socket.data.userId, text, ts: Date.now() }];
      await prisma.voiceRoom.update({ where: { id: roomId },  { chatMessages: chat } });
      ns.to(roomId).emit('chat:new', chat[chat.length - 1]);
    });

    socket.on('music:add', async ({ track }) => {
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
      const queue = [...(room?.musicQueue as any[] || []), track];
      await prisma.voiceRoom.update({ where: { id: roomId },  { musicQueue: queue } });
      ns.to(roomId).emit('queue:update', queue);
    });

    socket.on('gift:send', async ({ toId, type, amount }) => {
      await prisma.$transaction([
        prisma.user.update({ where: { id: socket.data.userId },  { coins: { decrement: amount } } }),
        prisma.gift.create({ data: { fromId: socket.data.userId, toId, roomId, type, amount } })
      ]);
      ns.to(roomId).emit('gift:trigger', { from: socket.data.userId, to: toId, type, amount });
    });

    socket.on('disconnect', () => {
      prisma.seat.deleteMany({ where: { roomId, userId: socket.data.userId } }).then(() => sync());
    });
  });
}
