import {

  Server,
  Socket

} from 'socket.io';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/prisma';

// ============================================
// TYPES
// ============================================

interface JwtPayload {

  userId: string;

}

interface MusicTrack {

  id?: string;

  title?: string;

  url?: string;

}

interface JoinPayload {

  roomId: string;

}

// ============================================
// CONSTANTS
// ============================================

const MAX_SEATS = 10;

const MAX_CHAT_LENGTH = 500;

const MAX_ROOM_USERS = 200;

// ============================================
// INIT VOICE SOCKETS
// ============================================

export function initVoiceSockets(

  io: Server

) {

  const ns = io.of('/voice');

  // ============================================
  // AUTH
  // ============================================

  ns.use(

    async (

      socket,
      next

    ) => {

      try {

        const token =

          socket.handshake.auth?.token;

        if (!token) {

          return next(

            new Error(

              'Authentication required'

            )

          );

        }

        const decoded = jwt.verify(

          token,

          process.env.JWT_SECRET as string

        ) as JwtPayload;

        socket.data.userId =

          decoded.userId;

        next();

      } catch (error) {

        console.error(

          'Voice Socket Auth Error:',

          error

        );

        return next(

          new Error(

            'Invalid token'

          )

        );

      }

    }

  );

  // ============================================
  // CONNECTION
  // ============================================

  ns.on(

    'connection',

    (socket: Socket) => {

      let currentRoom:

        string | null = null;

      // ========================================
      // JOIN ROOM
      // ========================================

      socket.on(

        'room:join',

        async (

          payload: JoinPayload

        ) => {

          try {

            const roomId =

              payload?.roomId;

            if (!roomId) {

              return socket.emit(

                'error',

                'Room ID required'

              );

            }

            // ====================================
            // FETCH ROOM
            // ====================================

            const room =

              await prisma.voiceRoom.findUnique({

                where: {

                  id: roomId,

                },

                include: {

                  seats: {

                    include: {

                      user: {

                        select: {

                          id: true,

                          username: true,

                          avatarUrl: true,

                          isVerified: true,

                        },

                      },

                    },

                  },

                },

              });

            // ====================================
            // ROOM CHECK
            // ====================================

            if (

              !room ||

              !room.isActive

            ) {

              return socket.emit(

                'error',

                'Room not active'

              );

            }

            // ====================================
            // MAX USERS CHECK
            // ====================================

            const clients =

              await ns.in(roomId)

                .fetchSockets();

            if (

              clients.length >=

              MAX_ROOM_USERS

            ) {

              return socket.emit(

                'error',

                'Room capacity full'

              );

            }

            // ====================================
            // LEAVE OLD ROOM
            // ====================================

            if (

              currentRoom &&

              currentRoom !== roomId

            ) {

              await prisma.seat.deleteMany({

                where: {

                  roomId: currentRoom,

                  userId:

                    socket.data.userId,

                },

              });

              socket.leave(

                currentRoom

              );

              await syncRoom(

                currentRoom

              );

            }

            currentRoom = roomId;

            socket.join(roomId);

            socket.emit(

              'room:sync',

              room

            );

            ns.to(roomId).emit(

              'room:userJoined',

              {

                userId:

                  socket.data.userId,

              }

            );

          } catch (error) {

            console.error(

              'Join Room Error:',

              error

            );

            socket.emit(

              'error',

              'Failed to join room'

            );

          }

        }

      );

      // ========================================
      // TAKE SEAT
      // ========================================

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

                    currentRoom,

                },

              });

            if (

              occupied >= MAX_SEATS

            ) {

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

                    socket.data.userId,

                },

              });

            if (existingSeat) {

              return;

            }

            await prisma.seat.create({

              data: {

                roomId:

                  currentRoom,

                userId:

                  socket.data.userId,

              },

            });

            await syncRoom(

              currentRoom

            );

          } catch (error) {

            console.error(

              'Take Seat Error:',

              error

            );

          }

        }

      );

      // ========================================
      // LEAVE SEAT
      // ========================================

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

                  socket.data.userId,

              },

            });

            await syncRoom(

              currentRoom

            );

          } catch (error) {

            console.error(

              'Leave Seat Error:',

              error

            );

          }

        }

      );

      // ========================================
      // MIC TOGGLE
      // ========================================

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

                  socket.data.userId,

              },

              data: {

                isMuted:
                  Boolean(isMuted),

                handRaised:
                  Boolean(handRaised),

              },

            });

            ns.to(currentRoom).emit(

              'seat:update',

              {

                userId:

                  socket.data.userId,

                isMuted,

                handRaised,

              }

            );

          } catch (error) {

            console.error(

              'Mic Toggle Error:',

              error

            );

          }

        }

      );

      // ========================================
      // CHAT
      // ========================================

      socket.on(

        'chat:send',

        async ({

          text

        }) => {

          try {

            if (

              !currentRoom ||

              !text ||

              typeof text !== 'string'

            ) {

              return;

            }

            const cleanText =

              text.trim();

            if (

              cleanText.length === 0 ||

              cleanText.length >

              MAX_CHAT_LENGTH

            ) {

              return socket.emit(

                'error',

                'Invalid message length'

              );

            }

            const msg = {

              userId:

                socket.data.userId,

              text: cleanText,

              ts: Date.now(),

            };

            ns.to(currentRoom).emit(

              'chat:new',

              msg

            );

          } catch (error) {

            console.error(

              'Chat Error:',

              error

            );

          }

        }

      );

      // ========================================
      // MUSIC PLAY
      // ========================================

      socket.on(

        'music:play',

        async ({

          trackUrl,
          offsetMs

        }) => {

          try {

            if (

              !currentRoom ||

              !trackUrl

            ) {

              return;

            }

            if (

              typeof trackUrl !==

              'string'

            ) {

              return;

            }

            await prisma.voiceRoom.update({

              where: {

                id: currentRoom,

              },

              data: {

                currentTrack:

                  trackUrl,

                isPlaying: true,

              },

            });

            ns.to(currentRoom).emit(

              'music:sync',

              {

                trackUrl,

                offsetMs:
                  Number(offsetMs) || 0,

              }

            );

          } catch (error) {

            console.error(

              'Music Play Error:',

              error

            );

          }

        }

      );

      // ========================================
      // MUSIC PAUSE
      // ========================================

      socket.on(

        'music:pause',

        async () => {

          try {

            if (!currentRoom) {

              return;

            }

            await prisma.voiceRoom.update({

              where: {

                id: currentRoom,

              },

              data: {

                isPlaying: false,

              },

            });

            ns.to(currentRoom).emit(

              'music:pause'

            );

          } catch (error) {

            console.error(

              'Music Pause Error:',

              error

            );

          }

        }

      );

      // ========================================
      // MUSIC QUEUE
      // ========================================

      socket.on(

        'music:queue:add',

        async ({

          track

        }: {

          track: MusicTrack

        }) => {

          try {

            if (

              !currentRoom ||

              !track

            ) {

              return;

            }

            const room =

              await prisma.voiceRoom.findUnique({

                where: {

                  id: currentRoom,

                },

              });

            const existingQueue =

              Array.isArray(

                room?.musicQueue

              )

                ? room?.musicQueue

                : [];

            const updatedQueue = [

              ...existingQueue,

              track,

            ];

            await prisma.voiceRoom.update({

              where: {

                id: currentRoom,

              },

              data: {

                musicQueue:

                  updatedQueue,

              },

            });

            ns.to(currentRoom).emit(

              'queue:update',

              updatedQueue

            );

          } catch (error) {

            console.error(

              'Queue Add Error:',

              error

            );

          }

        }

      );

      // ========================================
      // SEND GIFT
      // ========================================

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

            const parsedAmount =

              Number(amount);

            if (

              !parsedAmount ||

              parsedAmount <= 0

            ) {

              return socket.emit(

                'error',

                'Invalid gift amount'

              );

            }

            if (

              toId ===

              socket.data.userId

            ) {

              return socket.emit(

                'error',

                'Cannot send gift to yourself'

              );

            }

            const sender =

              await prisma.user.findUnique({

                where: {

                  id:

                    socket.data.userId,

                },

              });

            if (

              !sender ||

              sender.coins <

              parsedAmount

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

                    socket.data.userId,

                },

                data: {

                  coins: {

                    decrement:

                      parsedAmount,

                  },

                },

              }),

              prisma.gift.create({

                data: {

                  fromId:

                    socket.data.userId,

                  toId,

                  roomId:

                    currentRoom,

                  type,

                  amount:

                    parsedAmount,

                },

              }),

            ]);

            ns.to(currentRoom).emit(

              'gift:trigger',

              {

                from:

                  socket.data.userId,

                to: toId,

                type,

                amount:

                  parsedAmount,

              }

            );

          } catch (error) {

            console.error(

              'Gift Send Error:',

              error

            );

          }

        }

      );

      // ========================================
      // DISCONNECT
      // ========================================

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

                  socket.data.userId,

              },

            });

            socket.leave(

              currentRoom

            );

            await syncRoom(

              currentRoom

            );

            ns.to(currentRoom).emit(

              'room:userLeft',

              {

                userId:

                  socket.data.userId,

              }

            );

          } catch (error) {

            console.error(

              'Disconnect Error:',

              error

            );

          }

        }

      );

      // ========================================
      // ROOM SYNC
      // ========================================

      async function syncRoom(

        roomId: string

      ) {

        try {

          const room =

            await prisma.voiceRoom.findUnique({

              where: {

                id: roomId,

              },

              include: {

                seats: {

                  include: {

                    user: {

                      select: {

                        id: true,

                        username: true,

                        avatarUrl: true,

                        isVerified: true,

                      },

                    },

                  },

                },

              },

            });

          ns.to(roomId).emit(

            'room:sync',

            room

          );

        } catch (error) {

          console.error(

            'Room Sync Error:',

            error

          );

        }

      }

    }

  );

}
