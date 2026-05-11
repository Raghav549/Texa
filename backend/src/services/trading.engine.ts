import { prisma } from '../config/db';

import { io } from '../app';

import cron from 'node-cron';

export function initTradingCron() {

  // =========================================
  // CREATE DAILY TRADE
  // Every Midnight
  // =========================================

  cron.schedule(
    '0 0 * * *',
    async () => {

      try {

        const labels = [
          'Coffee',
          'Tea',
          'IG',
          'YT',
          'Summer',
          'Winter',
          'Night',
          'Morning',
          'Online',
          'Offline'
        ];

        const choices =
          Array.from(
            { length: 10 },
            (_, i) => ({
              id: `c${i + 1}`,

              label: labels[i],

              votes: 0,

              invested: 0
            })
          );

        await prisma.tradeDay.create({
          data: {
            date: new Date(),

            choices,

            isActive: true
          }
        });

      } catch (error) {

        console.error(
          'Create trade cron error:',
          error
        );
      }
    }
  );

  // =========================================
  // RESOLVE DAILY TRADE
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
            (prev, curr) =>
              (
                curr.votes +
                curr.invested
              ) >
              (
                prev.votes +
                prev.invested
              )
                ? curr
                : prev
          );

        const winnerVotes =
          await prisma.tradeVote.findMany({
            where: {
              tradeId: trade.id,

              choiceId: winner.id,

              isInvested: true
            }
          });

        await prisma.$transaction([

          ...winnerVotes.map((v) =>
            prisma.user.update({
              where: {
                id: v.userId
              },

              data: {
                coins: {
                  increment: v.amount
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
          'trading:reset',
          {
            date:
              new Date().toISOString()
          }
        );

      } catch (error) {

        console.error(
          'Resolve trade cron error:',
          error
        );
      }
    }
  );
}
