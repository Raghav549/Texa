import { Request, Response } from 'express';

import { prisma } from '../config/db';

import { uploadFile } from '../utils/upload';

import { io } from '../app';

export const createRoom = async (
  req: Request,
  res: Response
) => {
  try {

    const { title } = req.body;

    const coverUrl = req.file
      ? await uploadFile(
          req.file,
          'room_covers'
        )
      : null;

    const room =
      await prisma.voiceRoom.create({
        data: {
          title,
          coverUrl,
          hostId: req.userId!
        }
      });

    res.status(201).json(room);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to create room'
    });
  }
};

export const getRooms = async (
  req: Request,
  res: Response
) => {
  try {

    const rooms =
      await prisma.voiceRoom.findMany({
        where: {
          isActive: true
        },

        include: {
          host: {
            select: {
              username: true,
              isVerified: true,
              avatarUrl: true
            }
          },

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
        },

        orderBy: {
          createdAt: 'desc'
        },

        take: 50
      });

    res.json(rooms);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to fetch rooms'
    });
  }
};

export const roomControl = async (
  req: Request,
  res: Response
) => {
  try {

    const {
      roomId,
      action,
      targetId
    } = req.body;

    const room =
      await prisma.voiceRoom.findUnique({
        where: {
          id: roomId
        },

        include: {
          host: true
        }
      });

    if (
      !room ||
      room.hostId !== req.userId!
    ) {
      return res.status(403).json({
        error:
          'Host/Admin only'
      });
    }

    if (action === 'mute') {

      await prisma.seat.updateMany({
        where: {
          roomId,
          userId: targetId
        },

        data: {
          isMuted: true
        }
      });
    }

    if (action === 'kick') {

      await prisma.seat.deleteMany({
        where: {
          roomId,
          userId: targetId
        }
      });
    }

    if (action === 'close') {

      await prisma.voiceRoom.update({
        where: {
          id: roomId
        },

        data: {
          isActive: false
        }
      });
    }

    io.to(roomId).emit(
      'room:control',
      {
        action,
        targetId
      }
    );

    res.json({
      status: 'executed'
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to control room'
    });
  }
};
