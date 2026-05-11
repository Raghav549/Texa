import { Server, Socket } from 'socket.io';
export function initNotificationSockets(io: Server) {
  const ns = io.of('/notifications');
  ns.on('connection', (socket: Socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.on('mark_read', (notificationIds: string[]) => {
      ns.to(`user:${socket.data.userId}`).emit('notification:read', notificationIds);
    });
  });
}
