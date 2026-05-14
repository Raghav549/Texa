import cron, { ScheduledTask } from 'node-cron';

import { prisma } from '../config/db';
import { redis } from '../config/redis';
import { io } from '../app';

type TradeChoice = {
  id: string;
  label: string;
  votes: number;
  invested: number;
};

type TradeVoteInput = {
  userId: string;
  choiceId: string;
};

type TradeInvestInput = {
  userId: string;
  choiceId: string;
  amount: number;
};

type TradingStatus = {
  initialized: boolean;
  timezone: string;
  activeJobs: string[];
  lastRun: Record<string, string>;
  lastError: Record<string, string>;
};

declare global {
  var tradingEngineStarted: boolean | undefined;
}

const MIN_INVEST = Number(process.env.TRADE_MIN_INVEST || 10);
const MAX_INVEST = Number(process.env.TRADE_MAX_INVEST || 100000);
const TRADE_TIMEZONE = process.env.TRADE_TIMEZONE || 'Asia/Kolkata';
const TRADE_LOCK_TTL_SECONDS = 240;
const DEFAULT_PAYOUT_MULTIPLIER = Number(process.env.TRADE_PAYOUT_MULTIPLIER || 2);
const tasks = new Map<string, ScheduledTask>();
const runningJobs = new Map<string, boolean>();
const lastRun = new Map<string, string>();
const lastError = new Map<string, string>();

const DEFAULT_CHOICES: TradeChoice[] = [
  { id: 'coffee', label: 'Coffee', votes: 0, invested: 0 },
  { id: 'tea', label: 'Tea', votes: 0, invested: 0 },
  { id: 'ig', label: 'Instagram', votes: 0, invested: 0 },
  { id: 'yt', label: 'YouTube', votes: 0, invested: 0 },
  { id: 'summer', label: 'Summer', votes: 0, invested: 0 },
  { id: 'winter', label: 'Winter', votes: 0, invested: 0 },
  { id: 'night', label: 'Night', votes: 0, invested: 0 },
  { id: 'morning', label: 'Morning', votes: 0, invested: 0 },
  { id: 'online', label: 'Online Shop', votes: 0, invested: 0 },
  { id: 'offline', label: 'Offline Shop', votes: 0, invested: 0 }
];

function getStartOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function getEndOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function normalizeChoiceId(choiceId: string) {
  return String(choiceId || '').trim();
}

function normalizeAmount(amount: number) {
  const value = Number(amount);
  if (!Number.isFinite(value)) throw new Error('Invalid amount');
  if (!Number.isInteger(value)) throw new Error('Amount must be integer');
  if (value < MIN_INVEST) throw new Error(`Minimum ${MIN_INVEST} coins`);
  if (value > MAX_INVEST) throw new Error('Investment too large');
  return value;
}

function normalizeChoices(value: any): TradeChoice[] {
  if (!Array.isArray(value)) return DEFAULT_CHOICES.map(choice => ({ ...choice }));
  return value
    .filter(item => item && typeof item.id === 'string')
    .map(item => ({
      id: String(item.id),
      label: String(item.label || item.id),
      votes: Math.max(0, Number(item.votes || 0)),
      invested: Math.max(0, Number(item.invested || 0))
    }));
}

function findChoice(choices: TradeChoice[], choiceId: string) {
  return choices.find(choice => choice.id === choiceId);
}

function getWinner(choices: TradeChoice[]) {
  return [...choices].sort((a, b) => {
    const bScore = Number(b.votes || 0) + Number(b.invested || 0);
    const aScore = Number(a.votes || 0) + Number(a.invested || 0);
    if (bScore !== aScore) return bScore - aScore;
    if (Number(b.invested || 0) !== Number(a.invested || 0)) return Number(b.invested || 0) - Number(a.invested || 0);
    return String(a.id).localeCompare(String(b.id));
  })[0] || null;
}

function tradeRoom(tradeId: string) {
  return `trade:${tradeId}`;
}

function lockKey(name: string) {
  return `trading:lock:${name}`;
}

async function acquireLock(name: string, ttl = TRADE_LOCK_TTL_SECONDS) {
  const result = await redis.set(lockKey(name), String(Date.now()), 'EX', ttl, 'NX').catch(() => null);
  return !!result;
}

async function releaseLock(name: string) {
  await redis.del(lockKey(name)).catch(() => undefined);
}

async function runJob(name: string, task: () => Promise<any>) {
  if (runningJobs.get(name)) return { skipped: true, reason: 'local_running' };

  const locked = await acquireLock(name);
  if (!locked) return { skipped: true, reason: 'distributed_locked' };

  runningJobs.set(name, true);

  try {
    const result = await task();
    lastRun.set(name, new Date().toISOString());
    lastError.delete(name);
    return result;
  } catch (error: any) {
    lastError.set(name, error?.message || 'unknown_error');
    console.error(`${name} error:`, error);
    return { failed: true, reason: error?.message || 'unknown_error' };
  } finally {
    runningJobs.set(name, false);
    await releaseLock(name);
  }
}

async function createCoinTransaction(tx: any, userId: string, amount: number, type: 'CREDIT' | 'DEBIT', source: string, metadata: any) {
  if (!tx.coinTransaction?.create) return null;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { coins: true }
  });

  return tx.coinTransaction.create({
    data: {
      userId,
      amount,
      balance: Number(user?.coins || 0),
      type,
      status: 'SUCCESS',
      source,
      metadata
    } as any
  }).catch(() => null);
}

async function emitTradeUpdate(tradeId: string, choices: TradeChoice[], extra: Record<string, any> = {}) {
  const payload = {
    tradeId,
    choices,
    updatedAt: new Date().toISOString(),
    ...extra
  };

  io.emit('trading:update', payload);
  io.to(tradeRoom(tradeId)).emit('trading:update', payload);
}

export async function createDailyTrade(force = false) {
  const startOfDay = getStartOfDay();
  const endOfDay = getEndOfDay();

  const existingTrade = await prisma.tradeDay.findFirst({
    where: {
      OR: [
        { date: startOfDay },
        {
          createdAt: {
            gte: startOfDay,
            lte: endOfDay
          }
        }
      ]
    } as any,
    orderBy: {
      createdAt: 'desc'
    } as any
  }).catch(() => null);

  if (existingTrade && !force) {
    return {
      created: false,
      trade: existingTrade
    };
  }

  if (existingTrade?.isActive) {
    await prisma.tradeDay.update({
      where: { id: existingTrade.id },
      data: { isActive: false } as any
    }).catch(() => null);
  }

  const trade = await prisma.tradeDay.create({
    data: {
      date: startOfDay,
      title: `Daily Trade ${startOfDay.toISOString().slice(0, 10)}`,
      choices: DEFAULT_CHOICES.map(choice => ({ ...choice })),
      isActive: true,
      openedAt: new Date()
    } as any
  });

  io.emit('trading:new_day', {
    tradeId: trade.id,
    choices: normalizeChoices((trade as any).choices)
  });

  return {
    created: true,
    trade
  };
}

export async function getActiveTrade() {
  const trade = await prisma.tradeDay.findFirst({
    where: {
      isActive: true
    },
    orderBy: {
      createdAt: 'desc'
    } as any
  });

  if (!trade) return null;

  const choices = normalizeChoices((trade as any).choices);
  const totalVotes = choices.reduce((sum, choice) => sum + Number(choice.votes || 0), 0);
  const totalInvested = choices.reduce((sum, choice) => sum + Number(choice.invested || 0), 0);

  return {
    ...trade,
    choices,
    totalVotes,
    totalInvested,
    closesAt: getEndOfDay()
  };
}

export async function getTradeById(tradeId: string) {
  const trade = await prisma.tradeDay.findUnique({
    where: {
      id: tradeId
    }
  });

  if (!trade) return null;

  const choices = normalizeChoices((trade as any).choices);
  const totalVotes = choices.reduce((sum, choice) => sum + Number(choice.votes || 0), 0);
  const totalInvested = choices.reduce((sum, choice) => sum + Number(choice.invested || 0), 0);

  return {
    ...trade,
    choices,
    totalVotes,
    totalInvested
  };
}

export async function voteTrade(userIdOrInput: string | TradeVoteInput, choiceIdArg?: string) {
  const userId = typeof userIdOrInput === 'string' ? userIdOrInput : userIdOrInput.userId;
  const choiceId = normalizeChoiceId(typeof userIdOrInput === 'string' ? choiceIdArg || '' : userIdOrInput.choiceId);

  if (!userId) throw new Error('User required');
  if (!choiceId) throw new Error('Invalid choice');

  const lockName = `vote:${userId}:${choiceId}`;
  const locked = await acquireLock(lockName, 20);
  if (!locked) throw new Error('Please wait');

  try {
    const result = await prisma.$transaction(async tx => {
      const trade = await tx.tradeDay.findFirst({
        where: {
          isActive: true
        },
        orderBy: {
          createdAt: 'desc'
        } as any
      });

      if (!trade) throw new Error('Trading closed');

      const choices = normalizeChoices((trade as any).choices);
      const selectedChoice = findChoice(choices, choiceId);
      if (!selectedChoice) throw new Error('Choice not found');

      const existingVote = await tx.tradeVote.findFirst({
        where: {
          tradeId: trade.id,
          userId
        } as any
      });

      if (existingVote) throw new Error('Already voted');

      selectedChoice.votes += 1;

      const vote = await tx.tradeVote.create({
        data: {
          tradeId: trade.id,
          userId,
          choiceId,
          isInvested: false,
          amount: 0
        } as any
      });

      const updatedTrade = await tx.tradeDay.update({
        where: {
          id: trade.id
        },
        data: {
          choices
        } as any
      });

      return {
        trade: updatedTrade,
        vote,
        choices
      };
    });

    await emitTradeUpdate(result.trade.id, result.choices, {
      action: 'vote',
      userId,
      choiceId
    });

    return result;
  } finally {
    await releaseLock(lockName);
  }
}

export async function investTrade(userIdOrInput: string | TradeInvestInput, choiceIdArg?: string, amountArg?: number) {
  const userId = typeof userIdOrInput === 'string' ? userIdOrInput : userIdOrInput.userId;
  const choiceId = normalizeChoiceId(typeof userIdOrInput === 'string' ? choiceIdArg || '' : userIdOrInput.choiceId);
  const amount = normalizeAmount(typeof userIdOrInput === 'string' ? Number(amountArg) : Number(userIdOrInput.amount));

  if (!userId) throw new Error('User required');
  if (!choiceId) throw new Error('Invalid choice');

  const lockName = `invest:${userId}:${choiceId}`;
  const locked = await acquireLock(lockName, 20);
  if (!locked) throw new Error('Please wait');

  try {
    const result = await prisma.$transaction(async tx => {
      const trade = await tx.tradeDay.findFirst({
        where: {
          isActive: true
        },
        orderBy: {
          createdAt: 'desc'
        } as any
      });

      if (!trade) throw new Error('Trading closed');

      const user = await tx.user.findUnique({
        where: {
          id: userId
        },
        select: {
          id: true,
          coins: true
        }
      });

      if (!user) throw new Error('User not found');
      if (Number(user.coins || 0) < amount) throw new Error('Insufficient coins');

      const choices = normalizeChoices((trade as any).choices);
      const selectedChoice = findChoice(choices, choiceId);
      if (!selectedChoice) throw new Error('Choice not found');

      selectedChoice.invested += amount;

      const updatedUser = await tx.user.update({
        where: {
          id: userId
        },
        data: {
          coins: {
            decrement: amount
          }
        }
      });

      const vote = await tx.tradeVote.upsert({
        where: {
          tradeId_userId_choiceId: {
            tradeId: trade.id,
            userId,
            choiceId
          }
        } as any,
        create: {
          tradeId: trade.id,
          userId,
          choiceId,
          isInvested: true,
          amount
        } as any,
        update: {
          amount: {
            increment: amount
          },
          isInvested: true
        } as any
      });

      const updatedTrade = await tx.tradeDay.update({
        where: {
          id: trade.id
        },
        data: {
          choices
        } as any
      });

      await createCoinTransaction(tx, userId, amount, 'DEBIT', 'TRADE', {
        tradeId: trade.id,
        choiceId,
        reason: 'trade_invest'
      });

      return {
        trade: updatedTrade,
        vote,
        user: updatedUser,
        choices
      };
    });

    await emitTradeUpdate(result.trade.id, result.choices, {
      action: 'invest',
      userId,
      choiceId,
      amount
    });

    return result;
  } finally {
    await releaseLock(lockName);
  }
}

export async function resolveDailyTrade() {
  const activeTrade = await prisma.tradeDay.findFirst({
    where: {
      isActive: true
    },
    orderBy: {
      createdAt: 'desc'
    } as any
  }).catch(() => null);

  if (!activeTrade) return { resolved: false, reason: 'no_active_trade' };

  const choices = normalizeChoices((activeTrade as any).choices);
  if (!choices.length) {
    await prisma.tradeDay.update({
      where: { id: activeTrade.id },
      data: {
        isActive: false,
        closedAt: new Date()
      } as any
    }).catch(() => null);

    return { resolved: false, reason: 'no_choices' };
  }

  const winner = getWinner(choices);
  if (!winner) return { resolved: false, reason: 'no_winner' };

  const result = await prisma.$transaction(async tx => {
    const lockedTrade = await tx.tradeDay.updateMany({
      where: {
        id: activeTrade.id,
        isActive: true
      },
      data: {
        isActive: false
      } as any
    });

    if (!lockedTrade.count) return { resolved: false, reason: 'already_locked' };

    const winners = await tx.tradeVote.findMany({
      where: {
        tradeId: activeTrade.id,
        choiceId: winner.id,
        isInvested: true
      } as any
    });

    let payoutUsers = 0;
    let totalPayout = 0;

    for (const winnerUser of winners as any[]) {
      const invested = Math.max(0, Number(winnerUser.amount || 0));
      if (invested <= 0) continue;

      const reward = Math.floor(invested * DEFAULT_PAYOUT_MULTIPLIER);
      if (reward <= 0) continue;

      await tx.user.update({
        where: {
          id: winnerUser.userId
        },
        data: {
          coins: {
            increment: reward
          }
        }
      });

      await createCoinTransaction(tx, winnerUser.userId, reward, 'CREDIT', 'TRADE', {
        tradeId: activeTrade.id,
        choiceId: winner.id,
        invested,
        multiplier: DEFAULT_PAYOUT_MULTIPLIER,
        reason: 'trade_win_payout'
      });

      payoutUsers++;
      totalPayout += reward;
    }

    const updatedTrade = await tx.tradeDay.update({
      where: {
        id: activeTrade.id
      },
      data: {
        closedAt: new Date(),
        winnerChoiceId: winner.id,
        winnerChoice: winner,
        payoutMultiplier: DEFAULT_PAYOUT_MULTIPLIER,
        totalPayout
      } as any
    });

    return {
      resolved: true,
      trade: updatedTrade,
      winner,
      payoutUsers,
      totalPayout
    };
  });

  if ((result as any).resolved) {
    io.emit('trading:resolved', {
      tradeId: activeTrade.id,
      winner,
      payoutUsers: (result as any).payoutUsers,
      totalPayout: (result as any).totalPayout
    });

    io.to(tradeRoom(activeTrade.id)).emit('trading:resolved', {
      tradeId: activeTrade.id,
      winner,
      payoutUsers: (result as any).payoutUsers,
      totalPayout: (result as any).totalPayout
    });
  }

  return result;
}

export async function getTradeLeaderboard(tradeId?: string, limit = 50) {
  const activeTrade = tradeId
    ? await prisma.tradeDay.findUnique({ where: { id: tradeId } })
    : await prisma.tradeDay.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' } as any
      });

  if (!activeTrade) return [];

  const rows = await prisma.tradeVote.groupBy({
    by: ['userId'],
    where: {
      tradeId: activeTrade.id,
      isInvested: true
    } as any,
    _sum: {
      amount: true
    },
    _count: {
      _all: true
    },
    orderBy: {
      _sum: {
        amount: 'desc'
      }
    } as any,
    take: Math.max(1, Math.min(100, Number(limit) || 50))
  }).catch(() => []);

  const userIds = (rows as any[]).map(row => row.userId).filter(Boolean);

  const users = await prisma.user.findMany({
    where: {
      id: {
        in: userIds
      }
    },
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      level: true
    } as any
  }).catch(() => []);

  const userMap = new Map((users as any[]).map(user => [user.id, user]));

  return (rows as any[]).map((row, index) => ({
    rank: index + 1,
    user: userMap.get(row.userId) || { id: row.userId },
    totalInvested: Number(row._sum?.amount || 0),
    entries: Number(row._count?._all || 0)
  }));
}

export async function getMyTradePosition(userId: string, tradeId?: string) {
  const trade = tradeId
    ? await prisma.tradeDay.findUnique({ where: { id: tradeId } })
    : await prisma.tradeDay.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' } as any
      });

  if (!trade) return null;

  const votes = await prisma.tradeVote.findMany({
    where: {
      tradeId: trade.id,
      userId
    } as any,
    orderBy: {
      createdAt: 'asc'
    } as any
  }).catch(() => []);

  const totalInvested = (votes as any[]).reduce((sum, vote) => sum + Number(vote.amount || 0), 0);

  return {
    tradeId: trade.id,
    userId,
    votes,
    totalInvested
  };
}

export function initTradingEngine() {
  if (global.tradingEngineStarted) return getTradingEngineStatus();

  global.tradingEngineStarted = true;

  const createTask = cron.schedule(
    '0 0 * * *',
    () => {
      void runJob('create_daily_trade', () => createDailyTrade(false));
    },
    {
      timezone: TRADE_TIMEZONE,
      scheduled: true
    }
  );

  const resolveTask = cron.schedule(
    '55 23 * * *',
    () => {
      void runJob('resolve_daily_trade', resolveDailyTrade);
    },
    {
      timezone: TRADE_TIMEZONE,
      scheduled: true
    }
  );

  tasks.set('create_daily_trade', createTask);
  tasks.set('resolve_daily_trade', resolveTask);

  setTimeout(() => {
    void runJob('ensure_daily_trade_on_start', async () => {
      const active = await getActiveTrade();
      if (active) return { created: false, reason: 'active_exists' };
      return createDailyTrade(false);
    });
  }, 1500);

  return getTradingEngineStatus();
}

export function stopTradingEngine() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
  runningJobs.clear();
  global.tradingEngineStarted = false;
  return getTradingEngineStatus();
}

export function getTradingEngineStatus(): TradingStatus {
  return {
    initialized: !!global.tradingEngineStarted,
    timezone: TRADE_TIMEZONE,
    activeJobs: Array.from(tasks.keys()),
    lastRun: Object.fromEntries(Array.from(lastRun.entries())),
    lastError: Object.fromEntries(Array.from(lastError.entries()))
  };
}

export async function runTradingJobNow(name: 'create_daily_trade' | 'resolve_daily_trade' | 'ensure_daily_trade_on_start') {
  const jobs = {
    create_daily_trade: () => createDailyTrade(false),
    resolve_daily_trade: resolveDailyTrade,
    ensure_daily_trade_on_start: async () => {
      const active = await getActiveTrade();
      if (active) return { created: false, reason: 'active_exists' };
      return createDailyTrade(false);
    }
  };

  return runJob(name, jobs[name]);
}
