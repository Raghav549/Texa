import { Request, Response } from "express";
import { prisma } from "../config/db";
import { io } from "../app";
import cron from "node-cron";

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

type LeaderboardPatch = {
  wins: number;
  losses: number;
  payout: number;
  invested: number;
  bestPayout: number;
};

const TRADE_ROOM = "trading";
const MIN_INVESTMENT = 10;
const MAX_INVESTMENT = 5000;
const WIN_MULTIPLIER = 2;
const XP_VOTE_REWARD = 2;
const XP_INVEST_REWARD = 5;
const XP_WIN_REWARD = 15;
const XP_LOSS_REWARD = 1;
const DAILY_CHOICE_PAIRS = 10;
const TRADE_LOCK_HOUR = 23;
const TRADE_LOCK_MINUTE = 55;

const CHOICE_BANK = [
  { a: "Coffee", b: "Tea", ai: "brew-core", bi: "leaf-core", category: "lifestyle" },
  { a: "Android", b: "iOS", ai: "pixel-core", bi: "orbit-core", category: "tech" },
  { a: "PlayStation", b: "Xbox", ai: "console-alpha", bi: "console-x", category: "gaming" },
  { a: "Morning", b: "Night", ai: "sunrise-line", bi: "moonline", category: "routine" },
  { a: "Summer", b: "Winter", ai: "heatwave", bi: "snowgrid", category: "season" },
  { a: "Car", b: "Travel", ai: "roadmark", bi: "airroute", category: "mobility" },
  { a: "Gym", b: "Relax", ai: "powerlift", bi: "calmwave", category: "health" },
  { a: "Book", b: "Movie", ai: "pageflow", bi: "screenbox", category: "media" },
  { a: "Pizza", b: "Burger", ai: "slicegrid", bi: "stackbite", category: "food" },
  { a: "Spotify", b: "YouTube", ai: "soundpulse", bi: "playframe", category: "platform" },
  { a: "Startup", b: "Job", ai: "rocketline", bi: "briefcase-pro", category: "career" },
  { a: "AI", b: "Human Skill", ai: "neural-dot", bi: "handcraft", category: "future" },
  { a: "Online", b: "Offline", ai: "cloudnode", bi: "groundlink", category: "life" },
  { a: "City", b: "Village", ai: "towergrid", bi: "fieldnode", category: "place" },
  { a: "Fashion", b: "Perfume", ai: "fabricmark", bi: "scentdrop", category: "brand" },
  { a: "Makhana", b: "Dry Fruits", ai: "lotus-seed", bi: "nutgrid", category: "food" },
  { a: "Local Market", b: "Online Store", ai: "bazaar-core", bi: "cart-cloud", category: "commerce" },
  { a: "Short Video", b: "Long Video", ai: "spark-reel", bi: "cinema-flow", category: "creator" },
  { a: "UPI", b: "Cash", ai: "upi-node", bi: "cashmark", category: "payment" },
  { a: "Study", b: "Business", ai: "booknode", bi: "tradecore", category: "growth" }
];

const ok = (res: Response, data: any, status = 200) => res.status(status).json(data);

const fail = (res: Response, status: number, error: string, message?: string) =>
  res.status(status).json({
    error,
    message: process.env.NODE_ENV === "development" ? message : undefined
  });

const safeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const safeInt = (value: any, fallback = 0, min?: number, max?: number) => {
  const n = Math.floor(safeNumber(value, fallback));
  if (typeof min === "number" && n < min) return min;
  if (typeof max === "number" && n > max) return max;
  return n;
};

const cleanText = (value: any, max = 120) => {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, max);
};

const startOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const nextDayStart = (date = new Date()) => {
  const d = startOfDay(date);
  d.setDate(d.getDate() + 1);
  return d;
};

const endLockTime = (date = new Date()) => {
  const d = startOfDay(date);
  d.setHours(TRADE_LOCK_HOUR, TRADE_LOCK_MINUTE, 0, 0);
  return d;
};

const isLocked = (day: any) => {
  if (!day?.lockedAt) return false;
  return new Date(day.lockedAt).getTime() <= Date.now();
};

const shuffle = <T,>(arr: T[]) => {
  const copy = [...arr];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }

  return copy;
};

const uniqueStringArray = (value: any) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(v => String(v)).filter(Boolean)));
};

const normalizeChoices = (choices: any): TradeChoice[] => {
  if (!Array.isArray(choices)) return [];

  return choices.map((c, i) => ({
    id: cleanText(c?.id || `c_${i}`, 40),
    text: cleanText(c?.text || `Choice ${i + 1}`, 80),
    votes: Math.max(0, safeInt(c?.votes)),
    investments: Math.max(0, safeInt(c?.investments)),
    voters: uniqueStringArray(c?.voters),
    investors: uniqueStringArray(c?.investors),
    color: cleanText(c?.color || `hsl(${i * 36}, 76%, 52%)`, 60),
    icon: cleanText(c?.icon || "node-core", 80),
    category: cleanText(c?.category || "general", 80)
  }));
};

const rankChoices = (choices: TradeChoice[]) => {
  return [...choices].sort((a, b) => {
    const aScore = a.votes + a.investments;
    const bScore = b.votes + b.investments;

    if (bScore !== aScore) return bScore - aScore;
    if (b.investments !== a.investments) return b.investments - a.investments;
    if (b.votes !== a.votes) return b.votes - a.votes;

    return a.id.localeCompare(b.id);
  });
};

const publicDayPayload = (day: any, userId?: string) => {
  const choices = normalizeChoices(day?.choices);
  const totalVotes = choices.reduce((sum, c) => sum + c.votes, 0);
  const totalInvestments = choices.reduce((sum, c) => sum + c.investments, 0);
  const winnerChoiceData = day?.winnerChoice ? choices.find(c => c.id === day.winnerChoice) || null : null;

  return {
    id: day?.id,
    date: day?.date,
    title: day?.title,
    lockedAt: day?.lockedAt,
    resolvedAt: day?.resolvedAt,
    winnerChoice: day?.winnerChoice || null,
    winnerChoiceData,
    isActive: Boolean(day?.isActive),
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
    locked: day ? isLocked(day) : false,
    serverTime: new Date()
  };
};

export function generateDailyChoices() {
  const selectedPairs = shuffle(CHOICE_BANK).slice(0, DAILY_CHOICE_PAIRS);
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

const findTodayTradingDay = async () => {
  const from = startOfDay();
  const to = nextDayStart();

  return prisma.tradingDay.findFirst({
    where: {
      date: {
        gte: from,
        lt: to
      }
    },
    orderBy: { date: "desc" }
  });
};

const createTodayTradingDay = async () => {
  const date = startOfDay();
  const existing = await findTodayTradingDay();

  if (existing) return existing;

  const day = await prisma.tradingDay.create({
    data: {
      date,
      title: `Daily Battle - ${date.toLocaleDateString("en-IN")}`,
      lockedAt: endLockTime(date),
      choices: generateDailyChoices(),
      isActive: true
    }
  });

  io.to(TRADE_ROOM).emit("trading:new_day", publicDayPayload(day));
  io.emit("trading:new_day", publicDayPayload(day));

  return day;
};

const createNotification = async (userId: string, type: string, title: string, body: string, data: any) => {
  await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      data,
      read: false
    } as any
  }).catch(() => null);
};

const updateLeaderboard = async (dayId: string) => {
  const investments = await prisma.tradeInvestment.findMany({
    where: { dayId },
    select: {
      userId: true,
      payout: true,
      amount: true,
      status: true
    }
  });

  const users = new Map<string, LeaderboardPatch>();

  for (const inv of investments) {
    const current = users.get(inv.userId) || {
      wins: 0,
      losses: 0,
      payout: 0,
      invested: 0,
      bestPayout: 0
    };

    const payout = safeNumber(inv.payout);
    const amount = safeNumber(inv.amount);

    current.invested += amount;
    current.payout += payout;
    current.bestPayout = Math.max(current.bestPayout, payout);

    if (inv.status === "won") current.wins += 1;
    if (inv.status === "lost") current.losses += 1;

    users.set(inv.userId, current);
  }

  for (const [userId, data] of users.entries()) {
    const existing = await prisma.tradeLeaderboard.findUnique({
      where: { userId }
    });

    const nextBest = Math.max(safeNumber(existing?.bestPayout), data.bestPayout);
    const nextStreak = data.wins > 0 && data.losses === 0 ? safeNumber(existing?.streak) + 1 : 0;

    await prisma.tradeLeaderboard.upsert({
      where: { userId },
      update: {
        totalWins: { increment: data.wins },
        totalLosses: { increment: data.losses },
        totalPayout: { increment: data.payout },
        totalInvested: { increment: data.invested },
        streak: nextStreak,
        bestPayout: nextBest,
        updatedAt: new Date()
      },
      create: {
        userId,
        totalWins: data.wins,
        totalLosses: data.losses,
        totalPayout: data.payout,
        totalInvested: data.invested,
        streak: data.wins > 0 && data.losses === 0 ? 1 : 0,
        bestPayout: data.bestPayout
      }
    });
  }
};

async function resolveTradingDay(day: any) {
  const resolved = await prisma.$transaction(async tx => {
    const freshDay = await tx.tradingDay.findUnique({
      where: { id: day.id }
    });

    if (!freshDay || !freshDay.isActive) return freshDay;

    const choices = normalizeChoices(freshDay.choices);

    if (!choices.length) {
      return tx.tradingDay.update({
        where: { id: freshDay.id },
        data: {
          isActive: false,
          resolvedAt: new Date(),
          winnerChoice: null,
          choices
        }
      });
    }

    const winner = rankChoices(choices)[0];

    const resolvedDay = await tx.tradingDay.update({
      where: { id: freshDay.id },
      data: {
        isActive: false,
        resolvedAt: new Date(),
        winnerChoice: winner.id,
        choices
      }
    });

    const investments = await tx.tradeInvestment.findMany({
      where: {
        dayId: freshDay.id,
        status: { in: ["pending", "active"] }
      }
    });

    for (const inv of investments) {
      const amount = safeNumber(inv.amount);

      if (inv.choiceId === winner.id) {
        const payout = amount * WIN_MULTIPLIER;

        await tx.user.update({
          where: { id: inv.userId },
          data: {
            coins: { increment: payout },
            xp: { increment: XP_WIN_REWARD }
          }
        });

        await tx.tradeInvestment.update({
          where: { id: inv.id },
          data: {
            status: "won",
            payout,
            resolvedAt: new Date()
          }
        });
      } else {
        await tx.user.update({
          where: { id: inv.userId },
          data: {
            xp: { increment: XP_LOSS_REWARD }
          }
        }).catch(() => null);

        await tx.tradeInvestment.update({
          where: { id: inv.id },
          data: {
            status: "lost",
            payout: 0,
            resolvedAt: new Date()
          }
        });
      }
    }

    return {
      resolvedDay,
      winner,
      choices,
      investments
    };
  });

  if (!resolved || !("resolvedDay" in resolved)) return resolved;

  await updateLeaderboard(resolved.resolvedDay.id);

  for (const inv of resolved.investments) {
    if (inv.choiceId === resolved.winner.id) {
      const payout = safeNumber(inv.amount) * WIN_MULTIPLIER;

      io.to(`user:${inv.userId}`).emit("trade:win", {
        dayId: resolved.resolvedDay.id,
        payout,
        choiceId: resolved.winner.id,
        choice: resolved.winner.text,
        multiplier: WIN_MULTIPLIER
      });

      await createNotification(
        inv.userId,
        "TRADE",
        "Trade won",
        `You won ${payout} coins`,
        {
          dayId: resolved.resolvedDay.id,
          payout,
          choiceId: resolved.winner.id
        }
      );
    } else {
      io.to(`user:${inv.userId}`).emit("trade:lost", {
        dayId: resolved.resolvedDay.id,
        choiceId: inv.choiceId,
        winnerChoiceId: resolved.winner.id,
        winnerChoice: resolved.winner.text
      });

      await createNotification(
        inv.userId,
        "TRADE",
        "Trade result",
        `Winning choice was ${resolved.winner.text}`,
        {
          dayId: resolved.resolvedDay.id,
          choiceId: inv.choiceId,
          winnerChoiceId: resolved.winner.id
        }
      );
    }
  }

  const payload = {
    dayId: resolved.resolvedDay.id,
    winner: resolved.winner,
    choices: resolved.choices,
    resolvedAt: resolved.resolvedDay.resolvedAt
  };

  io.to(TRADE_ROOM).emit("trading:resolved", payload);
  io.emit("trading:resolved", payload);

  return resolved.resolvedDay;
}

let tradingCronInitialized = false;

export const initTradingCron = () => {
  if (tradingCronInitialized) return;
  tradingCronInitialized = true;

  cron.schedule("0 0 * * *", async () => {
    try {
      await createTodayTradingDay();
    } catch (err) {
      console.error("Trading day creation failed:", err);
    }
  });

  cron.schedule("55 23 * * *", async () => {
    try {
      const today = await findTodayTradingDay();

      if (!today || !today.isActive) return;

      await resolveTradingDay(today);
    } catch (err) {
      console.error("Trading day resolution failed:", err);
    }
  });
};

export const getActiveTrading = async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    let day = await prisma.tradingDay.findFirst({
      where: { isActive: true },
      orderBy: { date: "desc" }
    });

    if (!day) {
      day = await createTodayTradingDay();
    }

    return ok(res, publicDayPayload(day, userId));
  } catch (err: any) {
    return fail(res, 500, "Failed to load active trading", err?.message);
  }
};

export const voteTrade = async (req: Request, res: Response) => {
  try {
    const dayId = cleanText(req.body.dayId, 80);
    const choiceId = cleanText(req.body.choiceId, 80);
    const userId = req.userId!;

    if (!dayId || !choiceId) return fail(res, 400, "dayId and choiceId required");

    const result = await prisma.$transaction(async tx => {
      const day = await tx.tradingDay.findUnique({
        where: { id: dayId }
      });

      if (!day || !day.isActive) throw new Error("Trading closed");
      if (isLocked(day)) throw new Error("Trading locked");

      const choices = normalizeChoices(day.choices);
      const choice = choices.find(c => c.id === choiceId);

      if (!choice) throw new Error("Choice not found");

      const alreadyVotedAny = choices.some(c => c.voters.includes(userId));
      if (alreadyVotedAny) throw new Error("Already voted today");

      choice.votes += 1;
      choice.voters = Array.from(new Set([...choice.voters, userId]));

      const updated = await tx.tradingDay.update({
        where: { id: dayId },
        data: { choices }
      });

      await tx.user.update({
        where: { id: userId },
        data: { xp: { increment: XP_VOTE_REWARD } }
      });

      return {
        updated,
        choice
      };
    });

    io.to(TRADE_ROOM).emit("trading:update", publicDayPayload(result.updated));

    return ok(res, {
      status: "voted",
      choiceId,
      votes: result.choice.votes,
      day: publicDayPayload(result.updated, userId)
    });
  } catch (err: any) {
    const message = err?.message || "Failed to vote";
    const status = ["Trading closed", "Trading locked", "Choice not found", "Already voted today"].includes(message) ? 400 : 500;
    return fail(res, status, message);
  }
};

export const investTrade = async (req: Request, res: Response) => {
  try {
    const dayId = cleanText(req.body.dayId, 80);
    const choiceId = cleanText(req.body.choiceId, 80);
    const amount = safeInt(req.body.amount);
    const userId = req.userId!;

    if (!dayId || !choiceId) return fail(res, 400, "dayId and choiceId required");
    if (amount < MIN_INVESTMENT) return fail(res, 400, `Minimum investment: ${MIN_INVESTMENT} coins`);
    if (amount > MAX_INVESTMENT) return fail(res, 400, `Maximum investment: ${MAX_INVESTMENT} coins`);

    const result = await prisma.$transaction(async tx => {
      const day = await tx.tradingDay.findUnique({
        where: { id: dayId }
      });

      if (!day || !day.isActive) throw new Error("Trading closed");
      if (isLocked(day)) throw new Error("Trading locked");

      const choices = normalizeChoices(day.choices);
      const choice = choices.find(c => c.id === choiceId);

      if (!choice) throw new Error("Choice not found");

      const existing = await tx.tradeInvestment.findFirst({
        where: {
          dayId,
          userId,
          status: { in: ["pending", "active"] }
        }
      });

      if (existing) throw new Error("Already invested today");

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true }
      });

      if (!user || safeNumber(user.coins) < amount) throw new Error("Insufficient coins");

      choice.investments += amount;
      choice.investors = Array.from(new Set([...choice.investors, userId]));

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
          status: "active",
          payout: 0
        }
      });

      const updatedDay = await tx.tradingDay.update({
        where: { id: dayId },
        data: { choices }
      });

      return {
        investment,
        updatedDay,
        choice
      };
    });

    io.to(TRADE_ROOM).emit("trading:update", publicDayPayload(result.updatedDay));

    io.to(`user:${userId}`).emit("trade:invested", {
      dayId,
      choiceId,
      amount,
      investmentId: result.investment.id
    });

    return ok(res, {
      status: "invested",
      investment: result.investment,
      investments: result.choice.investments,
      day: publicDayPayload(result.updatedDay, userId)
    });
  } catch (err: any) {
    const message = err?.message || "Failed to invest";
    const status = ["Trading closed", "Trading locked", "Choice not found", "Already invested today", "Insufficient coins"].includes(message) ? 400 : 500;
    return fail(res, status, message);
  }
};

export const switchTradeInvestment = async (req: Request, res: Response) => {
  try {
    const dayId = cleanText(req.body.dayId, 80);
    const choiceId = cleanText(req.body.choiceId, 80);
    const userId = req.userId!;

    if (!dayId || !choiceId) return fail(res, 400, "dayId and choiceId required");

    const result = await prisma.$transaction(async tx => {
      const day = await tx.tradingDay.findUnique({
        where: { id: dayId }
      });

      if (!day || !day.isActive) throw new Error("Trading closed");
      if (isLocked(day)) throw new Error("Trading locked");

      const investment = await tx.tradeInvestment.findFirst({
        where: {
          dayId,
          userId,
          status: { in: ["pending", "active"] }
        }
      });

      if (!investment) throw new Error("No active investment found");
      if (investment.choiceId === choiceId) throw new Error("Already invested in this choice");

      const choices = normalizeChoices(day.choices);
      const oldChoice = choices.find(c => c.id === investment.choiceId);
      const newChoice = choices.find(c => c.id === choiceId);

      if (!newChoice) throw new Error("Choice not found");

      if (oldChoice) {
        oldChoice.investments = Math.max(0, oldChoice.investments - safeNumber(investment.amount));
        oldChoice.investors = oldChoice.investors.filter(id => id !== userId);
      }

      newChoice.investments += safeNumber(investment.amount);
      newChoice.investors = Array.from(new Set([...newChoice.investors, userId]));

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

      return {
        updatedDay,
        updatedInvestment
      };
    });

    io.to(TRADE_ROOM).emit("trading:update", publicDayPayload(result.updatedDay));

    io.to(`user:${userId}`).emit("trade:switched", {
      dayId,
      choiceId,
      investmentId: result.updatedInvestment.id
    });

    return ok(res, {
      status: "switched",
      investment: result.updatedInvestment,
      day: publicDayPayload(result.updatedDay, userId)
    });
  } catch (err: any) {
    const message = err?.message || "Failed to switch investment";
    const status = ["Trading closed", "Trading locked", "No active investment found", "Already invested in this choice", "Choice not found"].includes(message) ? 400 : 500;
    return fail(res, status, message);
  }
};

export const getTradingHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = safeInt(req.query.limit, 20, 1, 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

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
            isActive: true,
            lockedAt: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1
    });

    const hasMore = history.length > limit;
    const items = hasMore ? history.slice(0, -1) : history;

    return ok(res, {
      history: items.map(item => {
        const choices = normalizeChoices(item.day?.choices);

        return {
          ...item,
          selectedChoice: choices.find(c => c.id === item.choiceId) || null,
          winnerChoiceData: choices.find(c => c.id === item.day?.winnerChoice) || null,
          profit: safeNumber(item.payout) - safeNumber(item.amount)
        };
      }),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      hasMore
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to load trading history", err?.message);
  }
};

export const getTradingLeaderboard = async (req: Request, res: Response) => {
  try {
    const limit = safeInt(req.query.limit, 50, 1, 100);

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
        { totalPayout: "desc" },
        { totalWins: "desc" },
        { streak: "desc" }
      ],
      take: limit
    });

    return ok(
      res,
      leaderboard.map((row, index) => {
        const wins = safeNumber(row.totalWins);
        const losses = safeNumber(row.totalLosses);
        const total = wins + losses;
        const payout = safeNumber(row.totalPayout);
        const invested = safeNumber(row.totalInvested);

        return {
          rank: index + 1,
          ...row,
          winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0,
          profit: payout - invested,
          roi: invested > 0 ? Number((((payout - invested) / invested) * 100).toFixed(2)) : 0
        };
      })
    );
  } catch (err: any) {
    return fail(res, 500, "Failed to load leaderboard", err?.message);
  }
};

export const getTradingStats = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const [stats, wins, losses, activeInvestment, leaderboard, rankRows] = await Promise.all([
      prisma.tradeInvestment.aggregate({
        where: { userId },
        _sum: { amount: true, payout: true },
        _count: true,
        _max: { payout: true }
      }),
      prisma.tradeInvestment.count({
        where: { userId, status: "won" }
      }),
      prisma.tradeInvestment.count({
        where: { userId, status: "lost" }
      }),
      prisma.tradeInvestment.findFirst({
        where: {
          userId,
          status: { in: ["pending", "active"] },
          day: { isActive: true }
        },
        include: {
          day: {
            select: {
              id: true,
              title: true,
              lockedAt: true,
              choices: true,
              isActive: true
            }
          }
        }
      }),
      prisma.tradeLeaderboard.findUnique({
        where: { userId }
      }),
      prisma.tradeLeaderboard.findMany({
        orderBy: [
          { totalPayout: "desc" },
          { totalWins: "desc" },
          { streak: "desc" }
        ],
        select: { userId: true }
      })
    ]);

    const totalInvested = safeNumber(stats._sum.amount);
    const totalPayout = safeNumber(stats._sum.payout);
    const completed = wins + losses;
    const rankIndex = rankRows.findIndex(row => row.userId === userId);

    return ok(res, {
      totalInvested,
      totalPayout,
      profit: totalPayout - totalInvested,
      roi: totalInvested > 0 ? Number((((totalPayout - totalInvested) / totalInvested) * 100).toFixed(2)) : 0,
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
      leaderboard: leaderboard || null,
      rank: rankIndex >= 0 ? rankIndex + 1 : null
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to load trading stats", err?.message);
  }
};

export const getTradingDayById = async (req: Request, res: Response) => {
  try {
    const { dayId } = req.params;
    const userId = req.userId;

    const day = await prisma.tradingDay.findUnique({
      where: { id: dayId }
    });

    if (!day) return fail(res, 404, "Trading day not found");

    return ok(res, publicDayPayload(day, userId));
  } catch (err: any) {
    return fail(res, 500, "Failed to load trading day", err?.message);
  }
};

export const getRecentTradingDays = async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const limit = safeInt(req.query.limit, 10, 1, 50);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    const days = await prisma.tradingDay.findMany({
      orderBy: { date: "desc" },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1
    });

    const hasMore = days.length > limit;
    const items = hasMore ? days.slice(0, -1) : days;

    return ok(res, {
      days: items.map(day => publicDayPayload(day, userId)),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      hasMore
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to load trading days", err?.message);
  }
};

export const resolveTradingManually = async (req: Request, res: Response) => {
  try {
    const { dayId } = req.params;

    const day = await prisma.tradingDay.findUnique({
      where: { id: dayId }
    });

    if (!day) return fail(res, 404, "Trading day not found");
    if (!day.isActive) return fail(res, 400, "Already resolved");

    const resolved = await resolveTradingDay(day);

    return ok(res, {
      status: "resolved",
      day: resolved ? publicDayPayload(resolved) : null
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to resolve trading day", err?.message);
  }
};

export const createTradingDayManually = async (req: Request, res: Response) => {
  try {
    const dateInput = req.body.date ? new Date(req.body.date) : new Date();
    const date = startOfDay(Number.isNaN(dateInput.getTime()) ? new Date() : dateInput);
    const from = startOfDay(date);
    const to = nextDayStart(date);

    const existing = await prisma.tradingDay.findFirst({
      where: {
        date: {
          gte: from,
          lt: to
        }
      }
    });

    if (existing) {
      return ok(res, {
        status: "exists",
        day: publicDayPayload(existing, req.userId)
      });
    }

    const title = cleanText(req.body.title, 120) || `Daily Battle - ${date.toLocaleDateString("en-IN")}`;

    const day = await prisma.tradingDay.create({
      data: {
        date,
        title,
        lockedAt: endLockTime(date),
        choices: generateDailyChoices(),
        isActive: true
      }
    });

    io.to(TRADE_ROOM).emit("trading:new_day", publicDayPayload(day));
    io.emit("trading:new_day", publicDayPayload(day));

    return ok(res, {
      status: "created",
      day: publicDayPayload(day, req.userId)
    }, 201);
  } catch (err: any) {
    return fail(res, 500, "Failed to create trading day", err?.message);
  }
};

export const cancelTradeInvestment = async (req: Request, res: Response) => {
  try {
    const { investmentId } = req.params;
    const userId = req.userId!;

    const result = await prisma.$transaction(async tx => {
      const investment = await tx.tradeInvestment.findFirst({
        where: {
          id: investmentId,
          userId,
          status: { in: ["pending", "active"] }
        },
        include: {
          day: true
        }
      });

      if (!investment) throw new Error("Investment not found");
      if (!investment.day?.isActive) throw new Error("Trading closed");
      if (isLocked(investment.day)) throw new Error("Trading locked");

      const choices = normalizeChoices(investment.day.choices);
      const choice = choices.find(c => c.id === investment.choiceId);

      if (choice) {
        choice.investments = Math.max(0, choice.investments - safeNumber(investment.amount));
        choice.investors = choice.investors.filter(id => id !== userId);
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { increment: safeNumber(investment.amount) }
        }
      });

      const updatedInvestment = await tx.tradeInvestment.update({
        where: { id: investment.id },
        data: {
          status: "cancelled",
          payout: 0,
          resolvedAt: new Date()
        }
      });

      const updatedDay = await tx.tradingDay.update({
        where: { id: investment.dayId },
        data: { choices }
      });

      return {
        updatedInvestment,
        updatedDay
      };
    });

    io.to(TRADE_ROOM).emit("trading:update", publicDayPayload(result.updatedDay));
    io.to(`user:${userId}`).emit("trade:cancelled", {
      investmentId,
      dayId: result.updatedDay.id
    });

    return ok(res, {
      status: "cancelled",
      investment: result.updatedInvestment,
      day: publicDayPayload(result.updatedDay, userId)
    });
  } catch (err: any) {
    const message = err?.message || "Failed to cancel investment";
    const status = ["Investment not found", "Trading closed", "Trading locked"].includes(message) ? 400 : 500;
    return fail(res, status, message);
  }
};

export const joinTradingRoom = async (req: Request, res: Response) => {
  try {
    return ok(res, {
      room: TRADE_ROOM,
      events: [
        "trading:new_day",
        "trading:update",
        "trading:resolved",
        "trade:invested",
        "trade:switched",
        "trade:cancelled",
        "trade:win",
        "trade:lost"
      ]
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to join trading room", err?.message);
  }
};
