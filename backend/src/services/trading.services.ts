import { prisma } from '../config/db';

import { io } from '../app';

import cron from 'node-cron';

const DEFAULT_CHOICES = [
  {
    id: 'coffee',
    label: 'Coffee',
    votes: 0,
    invested: 0
  },
  {
    id: 'tea',
    label: 'Tea',
    votes: 0,
    invested: 0
  },
  {
    id: 'ig',
    label: 'Instagram',
    votes: 0,
    invested: 0
  },
  {
    id: 'yt',
    label: 'YouTube',
    votes: 0,
    invested: 0
  },
  {
    id: 'summer',
    label: 'Summer',
    votes: 0,
    invested: 0
  },
  {
    id: 'winter',
    label: 'Winter',
    votes: 0,
    invested: 0
  },
  {
    id: 'night',
    label: 'Night',
    votes: 0,
    invested: 0
  },
  {
    id: 'morning',
    label: 'Morning',
    votes: 0,
    invested: 0
  },
  {
    id: 'online',
    label: 'Online Shop',
    votes: 0,
    invested: 0
  },
  {
    id: 'offline',
    label: 'Offline Shop',
    votes: 0,
    invested: 0
  }
];

export function initTradingEngine() {

  // =====================================
  // CREATE DAILY TRADE
  // =====================================

  cron.schedule(
    '0 0 * * *',
    async () => {

      try {

        await prisma.tradeDay.create({
          data: {
            date: new Date(),

            choices: DEFAULT_CHOICES,

            isActive: true
          }
        });

      } catch (error) {

        console.error(
          'Create trade error:',
          error
        );
      }
    }
  );

  // =====================================
  // RESOLVE DAILY TRADE
  // =====================================

  cron.schedule(
    '55 23 * * *',
    async () => {

      try {

        const active =
          await prisma.tradeDay.findFirst({
            where: {
              isActive: true
            }
          });

        if (!active) {
          return;
        }

        const choices =
          active.choices as typeof DEFAULT_CHOICES;

        const winner =
          [...choices].sort(
            (a, b) =>
              (
                b.votes +
                b.invested
              ) -
              (
                a.votes +
                a.invested
              )
          )[0];

        const winners =
          await prisma.tradeVote.findMany({
            where: {
              tradeId: active.id,

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

          prisma.tradeDay.update({
            where: {
              id: active.id
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
          'Resolve trade error:',
          error
        );
      }
    }
  );
}

export async function voteTrade(
  userId: string,
  choiceId: string
) {

  const trade =
    await prisma.tradeDay.findFirst({
      where: {
        isActive: true
      }
    });

  if (!trade) {
    throw new Error(
      'Trading closed'
    );
  }

  const exists =
    await prisma.tradeVote.findFirst({
      where: {
        tradeId: trade.id,
        userId,
        choiceId
      }
    });

  if (exists) {
    throw new Error(
      'Already voted'
    );
  }

  await prisma.tradeVote.create({
    data: {
      tradeId: trade.id,
      userId,
      choiceId
    }
  });

  const choices =
    trade.choices as any[];

  const idx =
    choices.findIndex(
      (c) => c.id === choiceId
    );

  if (idx === -1) {
    throw new Error(
      'Choice not found'
    );
  }

  choices[idx].votes += 1;

  await prisma.tradeDay.update({
    where: {
      id: trade.id
    },

    data: {
      choices
    }
  });

  io.emit(
    'trading:update',
    {
      choices,
      tradeId: trade.id
    }
  );
}

export async function investTrade(
  userId: string,
  choiceId: string,
  amount: number
) {

  if (amount < 10) {
    throw new Error(
      'Minimum 10 coins'
    );
  }

  const user =
    await prisma.user.findUnique({
      where: {
        id: userId
      }
    });

  if (
    !user ||
    user.coins < amount
  ) {
    throw new Error(
      'Insufficient coins'
    );
  }

  const trade =
    await prisma.tradeDay.findFirst({
      where: {
        isActive: true
      }
    });

  if (!trade) {
    throw new Error(
      'Trading closed'
    );
  }

  const choices =
    trade.choices as any[];

  const idx =
    choices.findIndex(
      (c) => c.id === choiceId
    );

  if (idx === -1) {
    throw new Error(
      'Choice not found'
    );
  }

  choices[idx].invested += amount;

  await prisma.$transaction([

    prisma.user.update({
      where: {
        id: userId
      },

      data: {
        coins: {
          decrement: amount
        }
      }
    }),

    prisma.tradeDay.update({
      where: {
        id: trade.id
      },

      data: {
        choices
      }
    }),

    prisma.tradeVote.upsert({
      where: {
        tradeId_userId_choiceId: {
          tradeId: trade.id,
          userId,
          choiceId
        }
      },

      create: {
        tradeId: trade.id,
        userId,
        choiceId,

        isInvested: true,

        amount
      },

      update: {
        amount: {
          increment: amount
        },

        isInvested: true
      }
    })
  ]);

  io.emit(
    'trading:update',
    {
      choices,
      tradeId: trade.id
    }
  );
}
