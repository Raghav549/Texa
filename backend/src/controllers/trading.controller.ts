import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';
import cron from 'node-cron';

type TradeChoice = {
  id: string;
  text: string;
  votes: number;
  investments: number;
  voters: string[];
  investors: string[];
  color: string;
  icon: string;
  category: string;
};

const TRADE_ROOM = 'trading';
const MIN_INVESTMENT = 10;
const MAX_INVESTMENT = 5000;
const WIN_MULTIPLIER = 2;
const XP_VOTE_REWARD = 2;
const XP_INVEST_REWARD = 5;
const XP_WIN_REWARD = 15;

const CHOICE_BANK = [
  { a: 'Coffee', b: 'Tea', ai: 'brew-core', bi: 'leaf-core', category: 'lifestyle' },
  { a: 'Android', b: 'iOS', ai: 'pixel-core', bi: 'orbit-core', category: 'tech' },
  { a: 'PlayStation', b: 'Xbox', ai: 'console-alpha', bi: 'console-x', category: 'gaming' },
  { a: 'Morning', b: 'Night', ai: 'sunrise-line', bi: 'moonline', category: 'routine' },
  { a: 'Summer', b: 'Winter', ai: 'heatwave', bi: 'snowgrid', category: 'season' },
  { a: 'Car', b: 'Travel', ai: 'roadmark', bi: 'airroute', category: 'mobility' },
  { a: 'Gym', b: 'Relax', ai: 'powerlift', bi: 'calmwave', category: 'health' },
  { a: 'Book', b: 'Movie', ai: 'pageflow', bi: 'screenbox', category: 'media' },
  { a: 'Pizza', b: 'Burger', ai: 'slicegrid', bi: 'stackbite', category: 'food' },
  { a: 'Spotify', b: 'YouTube', ai: 'soundpulse', bi: 'playframe', category: 'platform' },
  { a: 'Startup', b: 'Job', ai: 'rocketline', bi: 'briefcase-pro', category: 'career' },
  { a: 'AI', b: 'Human Skill', ai: 'neural-dot', bi: 'handcraft', category: 'future' },
  { a: 'Online', b: 'Offline', ai: 'cloudnode', bi: 'groundlink', category: 'life' },
  { a: 'City', b: 'Village', ai: 'towergrid', bi: 'fieldnode', category: 'place' },
  { a: 'Fashion', b: 'Perfume', ai: 'fabricmark', bi: 'scentdrop', category: 'brand' }
];

const safeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endLockTime = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(23, 55, 0, 0);
  return d;
};

const shuffle = <T,>(arr: T[]) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
};

const normalizeChoices = (choices: any): TradeChoice[] => {
  if (!Array.isArray(choices)) return [];
  return choices.map((c, i) => ({
    id: String(c.id || `c_${i}`),
    text: String(c.text || `Choice ${i + 1}`),
    votes: safeNumber(c.votes),
    investments: safeNumber(c.investments),
    voters: Array.isArray(c.voters) ? c.voters : [],
    investors: Array.isArray(c.investors) ? c.investors : [],
    color: String(c.color || `hsl(${i * 36}, 76%, 52%)`),
    icon: String(c.icon || 'node-core'),
    category: String(c.category || 'general')
  }));
};

const publicDayPayload = (day: any, userId?: string) => {
  const choices = normalizeChoices(day?.choices);
  const totalVotes = choices.reduce((sum, c) => sum + c.votes, 0);
  const totalInvestments = choices.reduce((sum, c) => sum + c.investments, 0);
  return {
    ...day,
    choices: choices.map(c => ({
      id: c.id,
      text: c.text,
      votes: c.votes,
      investments: c.investments,
      color: c.color,
      icon: c.icon,
      category: c.category,
      votePercent: totalVotes > 0 ? Number(((c.votes / totalVotes) * 100).toFixed(2)) : 0,
      investmentPercent: totalInvestments > 0 ? Number(((c.investments / totalInvestments) * 100).toFixed(2)) : 0,
      selectedByMe: userId ? c.voters.includes(userId) : false,
      investedByMe: userId ? c.investors.includes(userId) : false
    })),
    totalVotes,
    totalInvestments,
    serverTime: new Date()
  };
};

export const initTradingCron = () => {
  cron.schedule('0 0 * * *', async () => {
    try {
      const date = startOfDay();
      const existing = await prisma.tradingDay.findFirst({ where: { date } });
      if (existing) return;
      const day = await prisma.tradingDay.create({
        data: {
          date,
          title: `Daily Battle - ${date.toLocaleDateString('en-IN')}`,
          lockedAt: endLockTime(date),
          choices: generateDailyChoices(),
          isActive: true
        }
      });
      io.to(TRADE_ROOM).emit('trading:new_day', publicDayPayload(day));
      io.emit('trading:new_day', publicDayPayload(day));
    } catch (err) {
      console.error('Trading day creation failed:', err);
    }
  });

  cron.schedule('55 23 * * *', async () => {
    try {
      const todayStart = startOfDay();
      const today = await prisma.tradingDay.findFirst({
        where: {
          date: todayStart,
          isActive: true
        }
      });
      if (!today) return;
      await resolveTradingDay(today);
    } catch (err) {
      console.error('Trading day resolution failed:', err);
    }
  });
};

export function generateDailyChoices() {
  const selectedPairs = shuffle(CHOICE_BANK).slice(0, 10);
  const choices: TradeChoice[] = [];
  selectedPairs.forEach((pair, index) => {
    choices.push({
      id: `c_${index * 2}`,
      text: pair.a,
      votes: 0,
      investments: 0,
      voters: [],
      investors: [],
      color: `hsl(${(index * 36) % 360}, 78%, 54%)`,
      icon: pair.ai,
      category: pair.category
    });
    choices.push({
      id: `c_${index * 2 + 1}`,
      text: pair.b,
      votes: 0,
      investments: 0,
      voters: [],
      investors: [],
      color: `hsl(${((index * 36) + 18) % 360}, 78%, 54%)`,
      icon: pair.bi,
      category: pair.category
    });
  });
  return choices;
}

async function resolveTradingDay(day: any) {
  const freshDay = await prisma.tradingDay.findUnique({ where: { id: day.id } });
  if (!freshDay || !freshDay.isActive) return freshDay;

  const choices = normalizeChoices(freshDay.choices);
  if (!choices.length) return freshDay;

  const ranked = [...choices].sort((a, b) => {
    const aScore = a.votes + a.investments;
    const bScore = b.votes + b.investments;
    if (bScore !== aScore) return bScore - aScore;
    if (b.investments !== a.investments) return b.investments - a.investments;
    return b.votes - a.votes;
  });

  const winner = ranked[0];

  const resolvedDay = await prisma.tradingDay.update({
    where: { id: freshDay.id },
    data: {
      isActive: false,
      resolvedAt: new Date(),
      winnerChoice: winner.id,
      choices
    }
  });

  const investments = await prisma.tradeInvestment.findMany({
    where: {
      dayId: freshDay.id,
      status: { in: ['pending', 'active'] }
    }
  });

  for (const inv of investments) {
    if (inv.choiceId === winner.id) {
      const payout = safeNumber(inv.amount) * WIN_MULTIPLIER;
      await prisma.$transaction([
        prisma.user.update({
          where: { id: inv.userId },
          data: {
            coins: { increment: payout },
            xp: { increment: XP_WIN_REWARD }
          }
        }),
        prisma.tradeInvestment.update({
          where: { id: inv.id },
          data: {
            status: 'won',
            payout,
            resolvedAt: new Date()
          }
        })
      ]);
      io.to(`user:${inv.userId}`).emit('trade:win', {
        dayId: freshDay.id,
        payout,
        choiceId: winner.id,
        choice: winner.text,
        multiplier: WIN_MULTIPLIER
      });
    } else {
      await prisma.tradeInvestment.update({
        where: { id: inv.id },
        data: {
          status: 'lost',
          payout: 0,
          resolvedAt: new Date()
        }
      });
      io.to(`user:${inv.userId}`).emit('trade:lost', {
        dayId: freshDay.id,
        choiceId: inv.choiceId,
        winnerChoiceId: winner.id,
        winnerChoice: winner.text
      });
    }
  }

  await updateLeaderboard(freshDay.id);

  io.to(TRADE_ROOM).emit('trading:resolved', {
    dayId: freshDay.id,
    winner,
    choices,
    resolvedAt: new Date()
  });

  io.emit('trading:resolved', {
    dayId: freshDay.id,
    winner,
    choices,
    resolvedAt: new Date()
  });

  return resolvedDay;
}

async function updateLeaderboard(dayId: string) {
  const investments = await prisma.tradeInvestment.findMany({
    where: { dayId },
    select: { userId: true, payout: true, amount: true, status: true }
  });

  const users = new Map<string, { wins: number; losses: number; payout: number; invested: number }>();

  for (const inv of investments) {
    const current = users.get(inv.userId) || { wins: 0, losses: 0, payout: 0, invested: 0 };
    current.invested += safeNumber(inv.amount);
    current.payout += safeNumber(inv.payout);
    if (inv.status === 'won') current.wins += 1;
    if (inv.status === 'lost') current.losses += 1;
    users.set(inv.userId, current);
  }

  for (const [userId, data] of users.entries()) {
    const won = data.wins > 0;
    await prisma.tradeLeaderboard.upsert({
      where: { userId },
      update: {
        totalWins: { increment: data.wins },
        totalLosses: { increment: data.losses },
        totalPayout: { increment: data.payout },
        totalInvested: { increment: data.invested },
        streak: won ? { increment: 1 } : 0,
        bestPayout: { increment: 0 },
        updatedAt: new Date()
      },
      create: {
        userId,
        totalWins: data.wins,
        totalLosses: data.losses,
        totalPayout: data.payout,
        totalInvested: data.invested,
        streak: won ? 1 : 0,
        bestPayout: data.payout
      }
    });

    const board = await prisma.tradeLeaderboard.findUnique({ where: { userId } });
    if (board && data.payout > safeNumber(board.bestPayout)) {
      await prisma.tradeLeaderboard.update({
        where: { userId },
        data: { bestPayout: data.payout }
      });
    }
  }
}

export const getActiveTrading = async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    let day = await prisma.tradingDay.findFirst({
      where: { isActive: true },
      orderBy: { date: 'desc' }
    });

    if (!day) {
      const date = startOfDay();
      day = await prisma.tradingDay.create({
        data: {
          date,
          title: `Daily Battle - ${date.toLocaleDateString('en-IN')}`,
          lockedAt: endLockTime(date),
          choices: generateDailyChoices(),
          isActive: true
        }
      });
      io.to(TRADE_ROOM).emit('trading:new_day', publicDayPayload(day));
    }

    res.json(publicDayPayload(day, userId));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load active trading' });
  }
};

export const voteTrade = async (req: Request, res: Response) => {
  try {
    const { dayId, choiceId } = req.body;
    const userId = req.userId!;

    if (!dayId || !choiceId) return res.status(400).json({ error: 'dayId and choiceId required' });

    const day = await prisma.tradingDay.findUnique({ where: { id: dayId } });
    if (!day || !day.isActive) return res.status(400).json({ error: 'Trading closed' });
    if (day.lockedAt && new Date(day.lockedAt).getTime() <= Date.now()) return res.status(400).json({ error: 'Trading locked' });

    const choices = normalizeChoices(day.choices);
    const choice = choices.find(c => c.id === choiceId);
    if (!choice) return res.status(404).json({ error: 'Choice not found' });

    const alreadyVotedAny = choices.some(c => c.voters.includes(userId));
    if (alreadyVotedAny) return res.status(400).json({ error: 'Already voted today' });

    choice.votes += 1;
    choice.voters.push(userId);

    const updated = await prisma.tradingDay.update({
      where: { id: dayId },
      data: { choices }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { xp: { increment: XP_VOTE_REWARD } }
    });

    io.to(TRADE_ROOM).emit('trading:update', publicDayPayload(updated));
    res.json({
      status: 'voted',
      choiceId,
      votes: choice.votes,
      day: publicDayPayload(updated, userId)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to vote' });
  }
};

export const investTrade = async (req: Request, res: Response) => {
  try {
    const { dayId, choiceId } = req.body;
    const amount = Math.floor(safeNumber(req.body.amount));
    const userId = req.userId!;

    if (!dayId || !choiceId) return res.status(400).json({ error: 'dayId and choiceId required' });
    if (amount < MIN_INVESTMENT) return res.status(400).json({ error: `Minimum investment: ${MIN_INVESTMENT} coins` });
    if (amount > MAX_INVESTMENT) return res.status(400).json({ error: `Maximum investment: ${MAX_INVESTMENT} coins` });

    const result = await prisma.$transaction(async tx => {
      const day = await tx.tradingDay.findUnique({ where: { id: dayId } });
      if (!day || !day.isActive) throw new Error('Trading closed');
      if (day.lockedAt && new Date(day.lockedAt).getTime() <= Date.now()) throw new Error('Trading locked');

      const choices = normalizeChoices(day.choices);
      const choice = choices.find(c => c.id === choiceId);
      if (!choice) throw new Error('Choice not found');

      const existing = await tx.tradeInvestment.findFirst({
        where: {
          dayId,
          userId,
          status: { in: ['pending', 'active'] }
        }
      });

      if (existing) throw new Error('Already invested today');

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || safeNumber(user.coins) < amount) throw new Error('Insufficient coins');

      choice.investments += amount;
      if (!choice.investors.includes(userId)) choice.investors.push(userId);

      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: amount },
          xp: { increment: XP_INVEST_REWARD }
        }
      });

      const investment = await tx.tradeInvestment.create({
        data: {
          dayId,
          userId,
          choiceId,
          amount,
          status: 'active',
          payout: 0
        }
      });

      const updatedDay = await tx.tradingDay.update({
        where: { id: dayId },
        data: { choices }
      });

      return { investment, updatedDay, choice };
    });

    io.to(TRADE_ROOM).emit('trading:update', publicDayPayload(result.updatedDay));
    io.to(`user:${userId}`).emit('trade:invested', {
      dayId,
      choiceId,
      amount,
      investmentId: result.investment.id
    });

    res.json({
      status: 'invested',
      investment: result.investment,
      investments: result.choice.investments,
      day: publicDayPayload(result.updatedDay, userId)
    });
  } catch (err: any) {
    const message = err?.message || 'Failed to invest';
    const status = ['Trading closed', 'Trading locked', 'Choice not found', 'Already invested today', 'Insufficient coins'].includes(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
};

export const switchTradeInvestment = async (req: Request, res: Response) => {
  try {
    const { dayId, choiceId } = req.body;
    const userId = req.userId!;

    if (!dayId || !choiceId) return res.status(400).json({ error: 'dayId and choiceId required' });

    const result = await prisma.$transaction(async tx => {
      const day = await tx.tradingDay.findUnique({ where: { id: dayId } });
      if (!day || !day.isActive) throw new Error('Trading closed');
      if (day.lockedAt && new Date(day.lockedAt).getTime() <= Date.now()) throw new Error('Trading locked');

      const investment = await tx.tradeInvestment.findFirst({
        where: {
          dayId,
          userId,
          status: { in: ['pending', 'active'] }
        }
      });

      if (!investment) throw new Error('No active investment found');
      if (investment.choiceId === choiceId) throw new Error('Already invested in this choice');

      const choices = normalizeChoices(day.choices);
      const oldChoice = choices.find(c => c.id === investment.choiceId);
      const newChoice = choices.find(c => c.id === choiceId);
      if (!newChoice) throw new Error('Choice not found');

      if (oldChoice) {
        oldChoice.investments = Math.max(0, oldChoice.investments - safeNumber(investment.amount));
        oldChoice.investors = oldChoice.investors.filter(id => id !== userId);
      }

      newChoice.investments += safeNumber(investment.amount);
      if (!newChoice.investors.includes(userId)) newChoice.investors.push(userId);

      const updatedInvestment = await tx.tradeInvestment.update({
        where: { id: investment.id },
        data: {
          choiceId,
          switchedAt: new Date()
        }
      });

      const updatedDay = await tx.tradingDay.update({
        where: { id: dayId },
        data: { choices }
      });

      return { updatedDay, updatedInvestment };
    });

    io.to(TRADE_ROOM).emit('trading:update', publicDayPayload(result.updatedDay));
    io.to(`user:${userId}`).emit('trade:switched', {
      dayId,
      choiceId,
      investmentId: result.updatedInvestment.id
    });

    res.json({
      status: 'switched',
      investment: result.updatedInvestment,
      day: publicDayPayload(result.updatedDay, userId)
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to switch investment' });
  }
};

export const getTradingHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(Math.max(safeNumber(req.query.limit, 20), 1), 100);
    const cursor = req.query.cursor as string | undefined;

    const history = await prisma.tradeInvestment.findMany({
      where: { userId },
      include: {
        day: {
          select: {
            id: true,
            date: true,
            winnerChoice: true,
            title: true,
            choices: true,
            resolvedAt: true,
            isActive: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1
    });

    const hasMore = history.length > limit;
    const items = hasMore ? history.slice(0, -1) : history;

    res.json({
      history: items.map(item => {
        const choices = normalizeChoices(item.day?.choices);
        return {
          ...item,
          selectedChoice: choices.find(c => c.id === item.choiceId) || null,
          winnerChoiceData: choices.find(c => c.id === item.day?.winnerChoice) || null
        };
      }),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      hasMore
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trading history' });
  }
};

export const getTradingLeaderboard = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(safeNumber(req.query.limit, 50), 1), 100);
    const leaderboard = await prisma.tradeLeaderboard.findMany({
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true,
            fullName: true
          }
        }
      },
      orderBy: [
        { totalPayout: 'desc' },
        { totalWins: 'desc' },
        { streak: 'desc' }
      ],
      take: limit
    });

    res.json(
      leaderboard.map((row, index) => ({
        rank: index + 1,
        ...row,
        winRate: safeNumber(row.totalWins) + safeNumber(row.totalLosses) > 0 ? Number(((safeNumber(row.totalWins) / (safeNumber(row.totalWins) + safeNumber(row.totalLosses))) * 100).toFixed(2)) : 0,
        profit: safeNumber(row.totalPayout) - safeNumber(row.totalInvested)
      }))
    );
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
};

export const getTradingStats = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const [stats, wins, losses, activeInvestment, leaderboard] = await Promise.all([
      prisma.tradeInvestment.aggregate({
        where: { userId },
        _sum: { amount: true, payout: true },
        _count: true,
        _max: { payout: true }
      }),
      prisma.tradeInvestment.count({ where: { userId, status: 'won' } }),
      prisma.tradeInvestment.count({ where: { userId, status: 'lost' } }),
      prisma.tradeInvestment.findFirst({
        where: {
          userId,
          status: { in: ['pending', 'active'] },
          day: { isActive: true }
        },
        include: {
          day: {
            select: {
              id: true,
              title: true,
              lockedAt: true,
              choices: true
            }
          }
        }
      }),
      prisma.tradeLeaderboard.findUnique({ where: { userId } })
    ]);

    const totalInvested = safeNumber(stats._sum.amount);
    const totalPayout = safeNumber(stats._sum.payout);
    const completed = wins + losses;

    res.json({
      totalInvested,
      totalPayout,
      profit: totalPayout - totalInvested,
      trades: stats._count || 0,
      wins,
      losses,
      winRate: completed > 0 ? Number(((wins / completed) * 100).toFixed(2)) : 0,
      bestPayout: safeNumber(stats._max.payout),
      activeInvestment: activeInvestment
        ? {
            ...activeInvestment,
            selectedChoice: normalizeChoices(activeInvestment.day?.choices).find(c => c.id === activeInvestment.choiceId) || null
          }
        : null,
      leaderboard: leaderboard || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trading stats' });
  }
};

export const resolveTradingManually = async (req: Request, res: Response) => {
  try {
    const { dayId } = req.params;
    const day = await prisma.tradingDay.findUnique({ where: { id: dayId } });
    if (!day) return res.status(404).json({ error: 'Trading day not found' });
    if (!day.isActive) return res.status(400).json({ error: 'Already resolved' });
    const resolved = await resolveTradingDay(day);
    res.json({ status: 'resolved', day: resolved });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve trading day' });
  }
};

export const joinTradingRoom = async (req: Request, res: Response) => {
  try {
    res.json({
      room: TRADE_ROOM,
      events: [
        'trading:new_day',
        'trading:update',
        'trading:resolved',
        'trade:invested',
        'trade:switched',
        'trade:win',
        'trade:lost'
      ]
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join trading room' });
  }
};
