import { prisma } from '../config/db';

import { io } from '../app';

import cron from 'node-cron';

// ============================================
// TYPES
// ============================================

interface TradeChoice {

  id: string;

  label: string;

  votes: number;

  invested: number;

}

// ============================================
// SINGLETON PROTECTION
// ============================================

declare global {

  // eslint-disable-next-line no-var
  var tradingEngineStarted:
    boolean | undefined;

}

// ============================================
// CONSTANTS
// ============================================

const MIN_INVEST = 10;

const MAX_INVEST = 100000;

const TRADE_TIMEZONE =
  'Asia/Kolkata';

// ============================================
// DEFAULT CHOICES
// ============================================

const DEFAULT_CHOICES:
  TradeChoice[] = [

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

// ============================================
// START OF DAY
// ============================================

function getStartOfDay() {

  const now = new Date();

  return new Date(

    now.getFullYear(),

    now.getMonth(),

    now.getDate(),

    0,
    0,
    0,
    0

  );

}

// ============================================
// INIT ENGINE
// ============================================

export function initTradingEngine() {

  // ==========================================
  // PREVENT DUPLICATE CRON
  // ==========================================

  if (global.tradingEngineStarted) {

    console.log(
      'Trading Engine already started'
    );

    return;

  }

  global.tradingEngineStarted = true;

  console.log(
    'Trading Engine Initialized'
  );

  // ==========================================
  // CREATE DAILY TRADE
  // ==========================================

  cron.schedule(

    '0 0 * * *',

    async () => {

      try {

        const startOfDay =
          getStartOfDay();

        const existingTrade =
          await prisma.tradeDay.findFirst({

            where: {

              date: startOfDay,

            },

          });

        if (existingTrade) {

          console.log(
            'Trade already exists'
          );

          return;

        }

        await prisma.tradeDay.create({

          data: {

            date: startOfDay,

            choices:
              DEFAULT_CHOICES,

            isActive: true,

          },

        });

        console.log(
          'Daily trade created'
        );

      } catch (error) {

        console.error(
          'Create Trade Error:',
          error
        );

      }

    },

    {

      timezone:
        TRADE_TIMEZONE,

    }

  );

  // ==========================================
  // RESOLVE DAILY TRADE
  // ==========================================

  cron.schedule(

    '55 23 * * *',

    async () => {

      try {

        const activeTrade =
          await prisma.tradeDay.findFirst({

            where: {

              isActive: true,

            },

          });

        if (!activeTrade) {

          return;

        }

        // ======================================
        // LOCK TRADE FIRST
        // ======================================

        await prisma.tradeDay.update({

          where: {

            id: activeTrade.id,

          },

          data: {

            isActive: false,

          },

        });

        const choices =
          activeTrade.choices as TradeChoice[];

        if (

          !Array.isArray(
            choices
          ) ||

          choices.length === 0

        ) {

          return;

        }

        // ======================================
        // FIND WINNER
        // ======================================

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

        // ======================================
        // FETCH WINNERS
        // ======================================

        const winners =
          await prisma.tradeVote.findMany({

            where: {

              tradeId:
                activeTrade.id,

              choiceId:
                winner.id,

              isInvested: true,

            },

          });

        // ======================================
        // PAYOUT
        // ======================================

        await prisma.$transaction(

          async (tx) => {

            for (

              const winnerUser

              of winners

            ) {

              // ==================================
              // 2X REWARD
              // ==================================

              const reward =
                winnerUser.amount * 2;

              await tx.user.update({

                where: {

                  id:
                    winnerUser.userId,

                },

                data: {

                  coins: {

                    increment:
                      reward,

                  },

                },

              });

            }

            await tx.tradeDay.update({

              where: {

                id:
                  activeTrade.id,

              },

              data: {

                closedAt:
                  new Date(),

              },

            });

          }

        );

        io.emit(

          'trading:resolved',

          {

            tradeId:
              activeTrade.id,

            winner,

          }

        );

        console.log(
          'Trade resolved'
        );

      } catch (error) {

        console.error(
          'Resolve Trade Error:',
          error
        );

      }

    },

    {

      timezone:
        TRADE_TIMEZONE,

    }

  );

}

// ============================================
// VOTE TRADE
// ============================================

export async function voteTrade(

  userId: string,

  choiceId: string

) {

  if (

    !choiceId ||

    typeof choiceId !==
      'string'

  ) {

    throw new Error(
      'Invalid choice'
    );

  }

  const trade =
    await prisma.tradeDay.findFirst({

      where: {

        isActive: true,

      },

    });

  if (!trade) {

    throw new Error(
      'Trading closed'
    );

  }

  const choices =
    trade.choices as TradeChoice[];

  const selectedChoice =
    choices.find(

      (choice) =>

        choice.id ===
        choiceId

    );

  if (!selectedChoice) {

    throw new Error(
      'Choice not found'
    );

  }

  const existingVote =
    await prisma.tradeVote.findFirst({

      where: {

        tradeId:
          trade.id,

        userId,

        choiceId,

      },

    });

  if (existingVote) {

    throw new Error(
      'Already voted'
    );

  }

  // ==========================================
  // UPDATE VOTE
  // ==========================================

  selectedChoice.votes += 1;

  await prisma.$transaction([

    prisma.tradeVote.create({

      data: {

        tradeId:
          trade.id,

        userId,

        choiceId,

      },

    }),

    prisma.tradeDay.update({

      where: {

        id: trade.id,

      },

      data: {

        choices,

      },

    }),

  ]);

  io.emit(

    'trading:update',

    {

      tradeId:
        trade.id,

      choices,

    }

  );

}

// ============================================
// INVEST TRADE
// ============================================

export async function investTrade(

  userId: string,

  choiceId: string,

  amount: number

) {

  // ==========================================
  // VALIDATION
  // ==========================================

  if (

    !Number.isInteger(amount)

  ) {

    throw new Error(
      'Amount must be integer'
    );

  }

  if (

    amount < MIN_INVEST

  ) {

    throw new Error(

      `Minimum ${MIN_INVEST} coins`

    );

  }

  if (

    amount > MAX_INVEST

  ) {

    throw new Error(
      'Investment too large'
    );

  }

  const trade =
    await prisma.tradeDay.findFirst({

      where: {

        isActive: true,

      },

    });

  if (!trade) {

    throw new Error(
      'Trading closed'
    );

  }

  const user =
    await prisma.user.findUnique({

      where: {

        id: userId,

      },

    });

  if (

    !user ||

    user.coins < amount

  ) {

    throw new Error(
      'Insufficient coins'
    );

  }

  const choices =
    trade.choices as TradeChoice[];

  const selectedChoice =
    choices.find(

      (choice) =>

        choice.id ===
        choiceId

    );

  if (!selectedChoice) {

    throw new Error(
      'Choice not found'
    );

  }

  // ==========================================
  // UPDATE INVESTMENT
  // ==========================================

  selectedChoice.invested += amount;

  await prisma.$transaction([

    prisma.user.update({

      where: {

        id: userId,

      },

      data: {

        coins: {

          decrement:
            amount,

        },

      },

    }),

    prisma.tradeDay.update({

      where: {

        id: trade.id,

      },

      data: {

        choices,

      },

    }),

    prisma.tradeVote.upsert({

      where: {

        tradeId_userId_choiceId: {

          tradeId:
            trade.id,

          userId,

          choiceId,

        },

      },

      create: {

        tradeId:
          trade.id,

        userId,

        choiceId,

        isInvested: true,

        amount,

      },

      update: {

        amount: {

          increment:
            amount,

        },

        isInvested: true,

      },

    }),

  ]);

  io.emit(

    'trading:update',

    {

      tradeId:
        trade.id,

      choices,

    }

  );

}
