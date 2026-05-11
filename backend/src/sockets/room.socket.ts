import {
  Server,
  Socket
} from 'socket.io';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/db';

export function initRoomSockets(
  io: Server
) {

  const ns = io.of('/rooms');

  // =====================================
  // AUTH
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
          'Room socket auth error:',
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

      // ================================
      // JOIN ROOM
      // ================================

      socket.on(
        'join',
        async ({ roomId }) => {

          try {

            socket.join(roomId);

            const room =
              await prisma.voiceRoom.findUnique({
                where: {
                  id: roomId
                },

                include: {
                  seats: {
                    include: {
                      user: {
                        select: {
                          username: true,
                          isVerified: true,
                          avatarUrl: true
                        }
                      }
                    }
                  }
                }
              });

            if (!room) {
              return socket.emit(
                'err',
                'Room not found'
              );
            }

            socket.emit(
              'room:sync',
              room
            );

          } catch (error) {

            console.error(
              'Join room error:',
              error
            );

            socket.emit(
              'err',
              'Failed to join room'
            );
          }
        }
      );

      // ================================
      // TAKE SEAT
      // ================================

      socket.on(
        'seat:take',
        async ({ roomId }) => {

          try {

            const taken =
              await prisma.seat.count({
                where: {
                  roomId
                }
              });

            if (taken >= 10) {
              return socket.emit(
                'err',
                'Room full'
              );
            }

            const existingSeat =
              await prisma.seat.findFirst({
                where: {
                  roomId,
                  userId:
                    socket.data.userId
                }
              });

            if (existingSeat) {
              return socket.emit(
                'err',
                'Already seated'
              );
            }

            await prisma.seat.create({
              data: {
                roomId,

                userId:
                  socket.data.userId
              }
            });

            const updated =
              await prisma.voiceRoom.findUnique({
                where: {
                  id: roomId
                },

                include: {
                  seats: {
                    include: {
                      user: true
                    }
                  }
                }
              });

            ns.to(roomId).emit(
              'seat:update',
              updated?.seats || []
            );

          } catch (error) {

            console.error(
              'Take seat error:',
              error
            );

            socket.emit(
              'err',
              'Failed to take seat'
            );
          }
        }
      );

      // ================================
      // TOGGLE MUTE
      // ================================

      socket.on(
        'seat:toggle',
        async ({
          seatId,
          mute
        }) => {

          try {

            await prisma.seat.update({
              where: {
                id: seatId
              },

              data: {
                isMuted: mute
              }
            });

            const seat =
              await prisma.seat.findUnique({
                where: {
                  id: seatId
                }
              });

            if (!seat) {
              return;
            }

            ns.to(
              seat.roomId
            ).emit(
              'seat:mute',
              {
                seatId,

                isMuted: mute
              }
            );

          } catch (error) {

            console.error(
              'Seat toggle error:',
              error
            );

            socket.emit(
              'err',
              'Failed to toggle seat'
            );
          }
        }
      );

      // ================================
      // DISCONNECT
      // ================================

      socket.on(
        'disconnect',
        () => {

          console.log(
            `Room socket disconnected: ${socket.data.userId}`
          );
        }
      );
    }
  );
}
