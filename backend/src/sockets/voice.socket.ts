import { Socket } from 'socket.io';
import { prisma } from '../config/db';

export function initVoiceSockets(io: any) {
  const namespace = io.of('/voice');
  namespace.on('connection', (socket: Socket) => {
    socket.on('room:create', async ({ title, hostId }) => {
      const room = await prisma.voiceRoom.create({
         { title, hostId, seats: { create: { userId: hostId, isHost: true } } }
      });
      socket.join(room.id);
      namespace.to(room.id).emit('room:created', room);
    });

    socket.on('seat:join', async ({ roomId, userId }) => {
      const occupied = await prisma.seat.count({ where: { roomId } });
      if (occupied >= 10) return socket.emit('error', 'Room full');
      
      const seat = await prisma.seat.create({ data: { roomId, userId } });
      const updated = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: true } } } });
      namespace.to(roomId).emit('room:update', updated);
    });

    socket.on('seat:mic', async ({ roomId, seatId, isMuted }) => {
      await prisma.seat.update({ where: { id: seatId },  { isMuted } });
      const updated = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: true } } } });
      namespace.to(roomId).emit('room:update', updated);
    });

    socket.on('gift:send', async ({ roomId, senderId, receiverId, amount }) => {
      await prisma.$transaction([
        prisma.user.update({ where: { id: senderId },  { coins: { decrement: amount } } }),
        prisma.user.update({ where: { id: receiverId },  { coins: { increment: amount } } }),
        prisma.gift.create({  { from: senderId, to: receiverId, type: 'gold_star', amount } }) // Add Gift model if needed
      ]);
      namespace.to(roomId).emit('gift:trigger', { senderId, receiverId, amount });
    });

    socket.on('music:queue:add', async ({ roomId, track }) => {
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId } });
      const queue = [...(room?.musicQueue as any[] || []), track];
      await prisma.voiceRoom.update({ where: { id: roomId },  { musicQueue: queue } });
      namespace.to(roomId).emit('room:queue:update', queue);
    });
  });
}
