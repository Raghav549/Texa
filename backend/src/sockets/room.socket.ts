import {
  Server,
  Socket
} from 'socket.io';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/db';

export function initVoiceSockets(
  io: Server
) {

  const ns = io.of('/voice');

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
          'Voice socket auth error:',
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

      let currentRoom:
        | string
        | null = null;

      // ================================
      // JOIN ROOM
      // ================================

      socket.on(
        'room:join',
        async ({ roomId }) => {

          try {

            currentRoom =
              roomId;

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
                          id: true,
                          username: true,
                          isVerified: true,
                          avatarUrl: true
                        }
                      }
                    }
                  }
                }
              });

            if (
              !room ||
              !room.isActive
            ) {
              return socket.emit(
                'error',
                'Room not active'
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
              'error',
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
        async () => {

          try {

            if (!currentRoom) {
              return;
            }

            const occupied =
              await prisma.seat.count({
                where: {
                  roomId:
                    currentRoom
                }
              });

            if (occupied >= 10) {
              return socket.emit(
                'error',
                'Room full'
              );
            }

            const existingSeat =
              await prisma.seat.findFirst({
                where: {
                  roomId:
                    currentRoom,

                  userId:
                    socket.data.userId
                }
              });

            if (existingSeat) {
              return;
            }

            await prisma.seat.create({
              data: {
                roomId:
                  currentRoom,

                userId:
                  socket.data.userId
              }
            });

            await syncRoom(
              currentRoom
            );

          } catch (error) {

            console.error(
              'Take seat error:',
              error
            );
          }
        }
      );

      // ================================
      // LEAVE SEAT
      // ================================

      socket.on(
        'seat:leave',
        async () => {

          try {

            if (!currentRoom) {
              return;
            }

            await prisma.seat.deleteMany({
              where: {
                roomId:
                  currentRoom,

                userId:
                  socket.data.userId
              }
            });

            await syncRoom(
              currentRoom
            );

          } catch (error) {

            console.error(
              'Leave seat error:',
              error
            );
          }
        }
      );

      // ================================
      // MIC TOGGLE
      // ================================

      socket.on(
        'seat:mic',
        async ({
          isMuted,
          handRaised
        }) => {

          try {

            if (!currentRoom) {
              return;
            }

            await prisma.seat.updateMany({
              where: {
                roomId:
                  currentRoom,

                userId:
                  socket.data.userId
              },

              data: {
                isMuted,
                handRaised
              }
            });

            ns.to(
              currentRoom
            ).emit(
              'seat:update',
              {
                userId:
                  socket.data.userId,

                isMuted,

                handRaised
              }
            );

          } catch (error) {

            console.error(
              'Mic update error:',
              error
            );
          }
        }
      );

      // ================================
      // MUSIC QUEUE
      // ================================

      socket.on(
        'music:queue:add',
        async ({ track }) => {

          try {

            if (!currentRoom) {
              return;
            }

            const room =
              await prisma.voiceRoom.findUnique({
                where: {
                  id: currentRoom
                }
              });

            const queue = [
              ...(
                (room?.musicQueue as any[]) ||
                []
              ),

              track
            ];

            await prisma.voiceRoom.update({
              where: {
                id: currentRoom
              },

              data: {
                musicQueue:
                  queue
              }
            });

            ns.to(
              currentRoom
            ).emit(
              'queue:update',
              queue
            );

          } catch (error) {

            console.error(
              'Queue add error:',
              error
            );
          }
        }
      );

      // ================================
      // MUSIC PLAY
      // ================================

      socket.on(
        'music:play',
        async ({
          trackUrl,
          offsetMs
        }) => {

          try {

            if (!currentRoom) {
              return;
            }

            await prisma.voiceRoom.update({
              where: {
                id: currentRoom
              },

              data: {
                currentTrack:
                  trackUrl,

                isPlaying: true
              }
            });

            ns.to(
              currentRoom
            ).emit(
              'music:sync',
              {
                trackUrl,
                offsetMs
              }
            );

          } catch (error) {

            console.error(
              'Music play error:',
              error
            );
          }
        }
      );

      // ================================
      // MUSIC PAUSE
      // ================================

      socket.on(
        'music:pause',
        async () => {

          try {

            if (!currentRoom) {
              return;
            }

            await prisma.voiceRoom.update({
              where: {
                id: currentRoom
              },

              data: {
                isPlaying: false
              }
            });

            ns.to(
              currentRoom
            ).emit(
              'music:pause'
            );

          } catch (error) {

            console.error(
              'Music pause error:',
              error
            );
          }
        }
      );

      // ================================
      // CHAT
      // ================================

      socket.on(
        'chat:send',
        async ({ text }) => {

          try {

            if (!currentRoom) {
              return;
            }

            const msg = {
              userId:
                socket.data.userId,

              text,

              ts: Date.now()
            };

            ns.to(
              currentRoom
            ).emit(
              'chat:new',
              msg
            );

          } catch (error) {

            console.error(
              'Chat send error:',
              error
            );
          }
        }
      );

      // ================================
      // GIFTS
      // ================================

      socket.on(
        'gift:send',
        async ({
          toId,
          type,
          amount
        }) => {

          try {

            if (!currentRoom) {
              return;
            }

            const sender =
              await prisma.user.findUnique({
                where: {
                  id:
                    socket.data.userId
                }
              });

            if (
              !sender ||
              sender.coins < amount
            ) {
              return socket.emit(
                'error',
                'Insufficient coins'
              );
            }

            await prisma.$transaction([

              prisma.user.update({
                where: {
                  id:
                    socket.data.userId
                },

                data: {
                  coins: {
                    decrement:
                      amount
                  }
                }
              }),

              prisma.gift.create({
                data: {
                  fromId:
                    socket.data.userId,

                  toId,

                  roomId:
                    currentRoom,

                  type,

                  amount
                }
              })
            ]);

            ns.to(
              currentRoom
            ).emit(
              'gift:trigger',
              {
                from:
                  socket.data.userId,

                to: toId,

                type,

                amount
              }
            );

          } catch (error) {

            console.error(
              'Gift send error:',
              error
            );
          }
        }
      );

      // ================================
      // DISCONNECT
      // ================================

      socket.on(
        'disconnect',
        async () => {

          try {

            if (!currentRoom) {
              return;
            }

            await prisma.seat.deleteMany({
              where: {
                roomId:
                  currentRoom,

                userId:
                  socket.data.userId
              }
            });

            await syncRoom(
              currentRoom
            );

            socket.leave(
              currentRoom
            );

          } catch (error) {

            console.error(
              'Disconnect cleanup error:',
              error
            );
          }
        }
      );

      // ================================
      // ROOM SYNC
      // ================================

      async function syncRoom(
        id: string
      ) {

        try {

          const room =
            await prisma.voiceRoom.findUnique({
              where: {
                id
              },

              include: {
                seats: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        username: true,
                        isVerified: true,
                        avatarUrl: true
                      }
                    }
                  }
                }
              }
            });

          ns.to(id).emit(
            'room:sync',
            room
          );

        } catch (error) {

          console.error(
            'Room sync error:',
            error
          );
        }
      }
    }
  );
}
