import { prisma } from '../config/db';

import { Level } from '@prisma/client';

import { io } from '../app';

export async function addXP(
  userId: string,
  points: number
) {

  try {

    const user =
      await prisma.user.findUnique({
        where: {
          id: userId
        }
      });

    if (!user) {
      return null;
    }

    const newXP =
      user.xp + points;

    let level: Level =
      'BRONZE';

    if (newXP >= 30) {
      level = 'DIAMOND';
    }

    else if (newXP >= 20) {
      level = 'PLATINUM';
    }

    else if (newXP >= 15) {
      level = 'GOLD';
    }

    else if (newXP >= 10) {
      level = 'SILVER';
    }

    const updated =
      await prisma.user.update({
        where: {
          id: userId
        },

        data: {
          xp: newXP,

          level
        }
      });

    if (
      updated.level !==
      user.level
    ) {

      io.to(userId).emit(
        'level:up',
        {
          newLevel:
            updated.level,

          xp:
            updated.xp
        }
      );
    }

    return updated;

  } catch (error) {

    console.error(
      'XP update error:',
      error
    );

    return null;
  }
}
