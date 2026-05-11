import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';

export function initRoomSockets(io: Server) {
  const ns = io.of('/rooms');
  ns.on('connection', (socket: Socket) => {
    socket.on('join', async ({ roomId }) => {
      socket.join(roomId);
      const room = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: { select: { username: true, isVerified: true, avatarUrl: true } } } } } });
      socket.emit('room:sync', room);
    });
    socket.on('seat:take', async ({ roomId }) => {
      const taken = await prisma.seat.count({ where: { roomId } });
      if (taken >= 10) return socket.emit('err', 'Room full');
      const seat = await prisma.seat.create({ data: { roomId, userId: socket.data.userId } });
      const updated = await prisma.voiceRoom.findUnique({ where: { id: roomId }, include: { seats: { include: { user: true } } } });
      ns.to(roomId).emit('seat:update', updated.seats);
    });
    socket.on('seat:toggle', async ({ seatId, mute }) => {
      await prisma.seat.update({ where: { id: seatId },  { isMuted: mute } });
      const seat = await prisma.seat.findUnique({ where: { id: seatId } });
      ns.to(seat!.roomId).emit('seat:mute', { seatId, isMuted: mute });
    });
  });
}
