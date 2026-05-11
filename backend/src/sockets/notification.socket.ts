import {
  Server,
  Socket
} from 'socket.io';

import jwt from 'jsonwebtoken';

export function initNotificationSockets(
  io: Server
) {

  const ns =
    io.of('/notifications');

  // =====================================
  // AUTH MIDDLEWARE
  // =====================================

  ns.use(
    async (socket, next) => {

      try {

        const token =
          socket.handshake.auth
            ?.token;

        if (!token) {
          return next(
            new Error(
              'Authentication required'
            )
          );
        }

        const decoded =
          jwt.verify(
            token,
            process.env
              .JWT_SECRET as string
          ) as {
            userId: string;
          };

        socket.data.userId =
          decoded.userId;

        next();

      } catch (error) {

        console.error(
          'Notification socket auth error:',
          error
        );

        next(
          new Error(
            'Invalid token'
          )
        );
      }
    }
  );

  // =====================================
  // CONNECTION
  // =====================================

  ns.on(
    'connection',
    (socket: Socket) => {

      try {

        const userId =
          socket.data.userId;

        socket.join(
          `user:${userId}`
        );

        // ============================
        // MARK READ
        // ============================

        socket.on(
          'mark_read',
          (
            notificationIds: string[]
          ) => {

            ns.to(
              `user:${userId}`
            ).emit(
              'notification:read',
              notificationIds
            );
          }
        );

        // ============================
        // DISCONNECT
        // ============================

        socket.on(
          'disconnect',
          () => {

            console.log(
              `Notification socket disconnected: ${userId}`
            );
          }
        );

      } catch (error) {

        console.error(
          'Notification socket error:',
          error
        );

        socket.disconnect();
      }
    }
  );
}
