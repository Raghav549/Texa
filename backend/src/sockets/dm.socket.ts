import {
  Server,
  Socket
} from 'socket.io';

import { prisma } from '../config/db';

import jwt from 'jsonwebtoken';

export function initDMSockets(
  io: Server
) {

  const ns = io.of('/dm');

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
              'Authentication token missing'
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
          'Socket auth error:',
          error
        );

        next(
          new Error(
            'Auth required'
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
        // TYPING
        // ============================

        socket.on(
          'dm:typing',
          ({ toId }) => {

            ns.to(
              `user:${toId}`
            ).emit(
              'dm:typing',
              {
                from: userId
              }
            );
          }
        );

        // ============================
        // STOP TYPING
        // ============================

        socket.on(
          'dm:stop_typing',
          ({ toId }) => {

            ns.to(
              `user:${toId}`
            ).emit(
              'dm:stop_typing',
              {
                from: userId
              }
            );
          }
        );

        // ============================
        // MESSAGE SEEN
        // ============================

        socket.on(
          'dm:seen',
          async ({
            msgId,
            senderId
          }) => {

            try {

              await prisma.message.updateMany({
                where: {
                  id: msgId,

                  status: {
                    in: [
                      'SENT',
                      'DELIVERED'
                    ]
                  }
                },

                data: {
                  status: 'SEEN'
                }
              });

              ns.to(
                `user:${senderId}`
              ).emit(
                'dm:status_update',
                {
                  msgId,
                  status: 'SEEN'
                }
              );

            } catch (error) {

              console.error(
                'Seen update error:',
                error
              );
            }
          }
        );

        // ============================
        // DISCONNECT
        // ============================

        socket.on(
          'disconnect',
          () => {

            console.log(
              `DM socket disconnected: ${userId}`
            );
          }
        );

      } catch (error) {

        console.error(
          'Socket connection error:',
          error
        );

        socket.disconnect();
      }
    }
  );
}
