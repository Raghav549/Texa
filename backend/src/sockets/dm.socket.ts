import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';

export function initDMSockets(io: Server) {
  const ns = io.of('/dm');
  ns.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch { next(new Error('Auth required')); }
  });

  ns.on('connection', (socket: Socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.on('dm:typing', ({ toId }) => ns.to(`user:${toId}`).emit('dm:typing', { from: socket.data.userId }));
    socket.on('dm:stop_typing', ({ toId }) => ns.to(`user:${toId}`).emit('dm:stop_typing', { from: socket.data.userId }));
    socket.on('dm:seen', async ({ msgId, senderId }) => {
      await prisma.message.updateMany({ where: { id: msgId, status: { in: ['SENT', 'DELIVERED'] } }, data: { status: 'SEEN' } });
      ns.to(`user:${senderId}`).emit('dm:status_update', { msgId, status: 'SEEN' });
    });
  });
}
