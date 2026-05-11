import { prisma } from '../config/db';

import { io } from '../app';

import { addXP } from './xp.service';

import { updateCoins } from './coin.service';

export async function handleDailyLogin(
  userId: string
) {
  try {

    const coins = 10;
    const xp = 5;

    await Promise.all([
      addXP(userId, xp),
      updateCoins(userId, coins)
    ]);

    io.to(userId).emit(
      'daily:reward',
      {
        streak: 1,
        coins,
        xp
      }
    );

  } catch (error) {

    console.error(
      'Daily login reward error:',
      error
    );
  }
}
