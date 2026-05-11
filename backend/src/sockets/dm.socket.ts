import { Server, Socket } from 'socket.io';
export function initDMSockets(io: Server) {
  const ns = io.of('/dm');
  ns.on('connection', (socket: Socket) => {
    const userId = (socket.request as any).userId;
    socket.join(`dm:${userId}`);
    socket.on('typing', ({ toId }) => {
      ns.to(`dm:${toId}`).emit('typing', { from: userId, typing: true });
    });
    socket.on('stopTyping', ({ toId }) => {
      ns.to(`dm:${toId}`).emit('typing', { from: userId, typing: false });
    });
  });
}
