import cron from 'node-cron';

import { prisma } from '../config/db';

import { io } from '../app';

export function initSchedulers() {

  // =========================================
  // 1. AUTO VERIFY CHECK
  // Every 5 Minutes
  // =========================================

  cron.schedule(
    '*/5 * * * *',
    async () => {

      try {

        const candidates =
          await prisma.user.findMany({
            where: {
              isVerified: false,

              followers: {
                isEmpty: false
              },

              NOT: {
                username: 'kashyap'
              }
            }
          });

        for (const user of candidates) {

          if (
            user.followers.length >= 1000
          ) {

            await prisma.user.update({
              where: {
                id: user.id
              },

              data: {
                isVerified: true
              }
            });

            io.to(user.id).emit(
              'verify:success',
              {
                userId: user.id
              }
            );
          }
        }

      } catch (error) {

        console.error(
          'Auto verify scheduler error:',
          error
        );
      }
    }
  );

  // =========================================
  // 2. STORY CLEANUP
  // Every Hour
  // =========================================

  cron.schedule(
    '0 * * * *',
    async () => {

      try {

        await prisma.story.deleteMany({
          where: {
            expiresAt: {
              lt: new Date()
            }
          }
        });

      } catch (error) {

        console.error(
          'Story cleanup error:',
          error
        );
      }
    }
  );

  // =========================================
  // 3. DAILY TRADING RESOLUTION
  // 11:55 PM
  // =========================================

  cron.schedule(
    '55 23 * * *',
    async () => {

      try {

        const trade =
          await prisma.tradeDay.findFirst({
            where: {
              isActive: true
            }
          });

        if (!trade) {
          return;
        }

        const choices =
          trade.choices as any[];

        if (
          !choices ||
          choices.length === 0
        ) {
          return;
        }

        const winner =
          choices.reduce(
            (a, b) =>
              (
                a.votes +
                a.invested
              ) >
              (
                b.votes +
                b.invested
              )
                ? a
                : b
          );

        const winners =
          await prisma.tradeVote.findMany({
            where: {
              tradeId: trade.id,
              choiceId: winner.id,
              isInvested: true
            }
          });

        await prisma.$transaction([

          ...winners.map((w) =>
            prisma.user.update({
              where: {
                id: w.userId
              },

              data: {
                coins: {
                  increment: w.amount
                }
              }
            })
          ),

          prisma.tradeVote.deleteMany({
            where: {
              tradeId: trade.id
            }
          }),

          prisma.tradeDay.update({
            where: {
              id: trade.id
            },

            data: {
              isActive: false,
              closedAt: new Date()
            }
          })
        ]);

        io.emit(
          'trading:reset'
        );

      } catch (error) {

        console.error(
          'Trading scheduler error:',
          error
        );
      }
    }
  );
}
