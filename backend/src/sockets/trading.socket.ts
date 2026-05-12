import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';

type TradingSocketData = {
  userId?: string;
  deviceId?: string;
  connectedAt: number;
  lastPingAt: number;
  lastSubscribeAt?: number;
};

type TradingChoice = {
  id: string;
  text: string;
  iconKey?: string;
  votes?: number;
  investments?: number;
  voters?: string[];
  investors?: string[];
  color?: string;
  gradient?: string[];
  category?: string;
};

const PRESENCE_TTL_MS = 45_000;
const SUBSCRIBE_COOLDOWN_MS = 1_200;
const VIEWER_BROADCAST_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const MAX_LIMIT = 50;

function now() {
  return Date.now();
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampLimit(value: any, fallback = 20) {
  const n = safeNumber(value, fallback);
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const header = socket.handshake.headers?.authorization;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

async function resolveUser(socket: Socket) {
  const token = getToken(socket);
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { userId?: string; id?: string; sub?: string };
    return decoded.userId || decoded.id || decoded.sub || null;
  } catch {
    return null;
  }
}

function sanitizeChoice(choice: TradingChoice, userId?: string) {
  const votes = safeNumber(choice.votes);
  const investments = safeNumber(choice.investments);
  const voters = Array.isArray(choice.voters) ? choice.voters : [];
  const investors = Array.isArray(choice.investors) ? choice.investors : [];
  return {
    id: choice.id,
    text: choice.text,
    iconKey: choice.iconKey || null,
    color: choice.color || null,
    gradient: Array.isArray(choice.gradient) ? choice.gradient : [],
    category: choice.category || null,
    votes,
    investments,
    votePercent: 0,
    investmentPercent: 0,
    selectedByMe: userId ? voters.includes(userId) : false,
    investedByMe: userId ? investors.includes(userId) : false
  };
}

async function buildTradingPayload(userId?: string) {
  const day = await prisma.tradingDay.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' }
  });

  if (!day) {
    return {
      isActive: false,
      serverTime: new Date().toISOString(),
      viewerCount: 0,
      day: null,
      myInvestment: null
    };
  }

  const rawChoices = Array.isArray(day.choices) ? (day.choices as TradingChoice[]) : [];
  const totalVotes = rawChoices.reduce((sum, c) => sum + safeNumber(c.votes), 0);
  const totalInvestments = rawChoices.reduce((sum, c) => sum + safeNumber(c.investments), 0);

  const choices = rawChoices.map(choice => {
    const item = sanitizeChoice(choice, userId);
    return {
      ...item,
      votePercent: totalVotes > 0 ? Number(((item.votes / totalVotes) * 100).toFixed(2)) : 0,
      investmentPercent: totalInvestments > 0 ? Number(((item.investments / totalInvestments) * 100).toFixed(2)) : 0
    };
  });

  const myInvestment = userId
    ? await prisma.tradeInvestment.findFirst({
        where: { dayId: day.id, userId, status: { in: ['active', 'pending'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          choiceId: true,
          amount: true,
          status: true,
          payout: true,
          createdAt: true
        }
      })
    : null;

  return {
    isActive: true,
    serverTime: new Date().toISOString(),
    day: {
      id: day.id,
      date: day.date,
      title: day.title,
      lockedAt: day.lockedAt,
      resolvedAt: day.resolvedAt,
      winnerChoice: day.winnerChoice,
      totalVotes,
      totalInvestments,
      choices
    },
    myInvestment
  };
}

async function getLeaderboard(limit: number) {
  return prisma.tradeLeaderboard.findMany({
    include: {
      user: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true
        }
      }
    },
    orderBy: [
      { totalWins: 'desc' },
      { totalPayout: 'desc' },
      { streak: 'desc' }
    ],
    take: limit
  });
}

async function getUserStats(userId: string) {
  const [aggregate, wins, losses, active, leaderboard] = await Promise.all([
    prisma.tradeInvestment.aggregate({
      where: { userId },
      _sum: { amount: true, payout: true },
      _count: true,
      _max: { payout: true }
    }),
    prisma.tradeInvestment.count({ where: { userId, status: 'won' } }),
    prisma.tradeInvestment.count({ where: { userId, status: 'lost' } }),
    prisma.tradeInvestment.findFirst({
      where: { userId, status: { in: ['active', 'pending'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        dayId: true,
        choiceId: true,
        amount: true,
        status: true,
        createdAt: true
      }
    }),
    prisma.tradeLeaderboard.findUnique({
      where: { userId },
      select: {
        totalWins: true,
        totalPayout: true,
        streak: true,
        bestPayout: true,
        totalLosses: true,
        totalInvested: true
      }
    })
  ]);

  const totalInvested = aggregate._sum.amount || 0;
  const totalPayout = aggregate._sum.payout || 0;
  const settled = wins + losses;

  return {
    totalInvested,
    totalPayout,
    profit: totalPayout - totalInvested,
    trades: aggregate._count || 0,
    wins,
    losses,
    winRate: settled > 0 ? Number(((wins / settled) * 100).toFixed(2)) : 0,
    bestPayout: aggregate._max.payout || leaderboard?.bestPayout || 0,
    activeInvestment: active,
    leaderboard
  };
}

async function getHistory(userId: string, cursor?: string, limitValue?: any) {
  const limit = clampLimit(limitValue, 20);
  const rows = await prisma.tradeInvestment.findMany({
    where: { userId },
    include: {
      day: {
        select: {
          id: true,
          date: true,
          title: true,
          winnerChoice: true,
          resolvedAt: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    take: limit + 1
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]?.id || null : null,
    hasMore
  };
}

function emitError(socket: Socket, code: string, message: string) {
  socket.emit('trading:error', {
    code,
    message,
    serverTime: new Date().toISOString()
  });
}

export function initTradingSockets(io: Server) {
  const ns = io.of('/trading');
  const presence = new Map<string, TradingSocketData>();

  const broadcastPresence = () => {
    const current = now();
    for (const [id, data] of presence.entries()) {
      if (current - data.lastPingAt > PRESENCE_TTL_MS) presence.delete(id);
    }
    ns.to('trading').emit('trading:presence', {
      viewerCount: presence.size,
      serverTime: new Date().toISOString()
    });
  };

  ns.use(async (socket: Socket, next) => {
    const userId = await resolveUser(socket);
    socket.data.userId = userId || undefined;
    socket.data.deviceId = typeof socket.handshake.auth?.deviceId === 'string' ? socket.handshake.auth.deviceId : undefined;
    socket.data.connectedAt = now();
    socket.data.lastPingAt = now();
    next();
  });

  ns.on('connection', async (socket: Socket) => {
    const data = socket.data as TradingSocketData;
    const userId = data.userId;

    socket.join('trading');
    if (userId) socket.join(`user:${userId}`);

    presence.set(socket.id, {
      userId,
      deviceId: data.deviceId,
      connectedAt: now(),
      lastPingAt: now()
    });

    socket.emit('trading:connected', {
      socketId: socket.id,
      authenticated: !!userId,
      serverTime: new Date().toISOString()
    });

    try {
      const payload = await buildTradingPayload(userId);
      socket.emit('trading:init', {
        ...payload,
        viewerCount: presence.size
      });
    } catch {
      emitError(socket, 'INIT_FAILED', 'Unable to load trading battle right now');
    }

    socket.on('trading:subscribe', async (ack?: (payload: any) => void) => {
      const socketData = socket.data as TradingSocketData;
      const current = now();

      if (socketData.lastSubscribeAt && current - socketData.lastSubscribeAt < SUBSCRIBE_COOLDOWN_MS) {
        const payload = {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Please wait before refreshing again',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(payload);
        else emitError(socket, payload.code, payload.message);
        return;
      }

      socketData.lastSubscribeAt = current;
      socket.join('trading');

      try {
        const payload = await buildTradingPayload(socketData.userId);
        const response = {
          ok: true,
          ...payload,
          viewerCount: presence.size
        };
        socket.emit('trading:init', response);
        if (typeof ack === 'function') ack(response);
      } catch {
        const response = {
          ok: false,
          code: 'SUBSCRIBE_FAILED',
          message: 'Unable to subscribe to trading battle',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:unsubscribe', () => {
      socket.leave('trading');
      socket.emit('trading:unsubscribed', {
        ok: true,
        serverTime: new Date().toISOString()
      });
    });

    socket.on('trading:refresh', async (ack?: (payload: any) => void) => {
      try {
        const payload = await buildTradingPayload((socket.data as TradingSocketData).userId);
        const response = {
          ok: true,
          ...payload,
          viewerCount: presence.size
        };
        socket.emit('trading:init', response);
        if (typeof ack === 'function') ack(response);
      } catch {
        const response = {
          ok: false,
          code: 'REFRESH_FAILED',
          message: 'Unable to refresh trading battle',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:leaderboard', async (payload?: { limit?: number }, ack?: (response: any) => void) => {
      try {
        const leaderboard = await getLeaderboard(clampLimit(payload?.limit, 50));
        const response = {
          ok: true,
          leaderboard,
          serverTime: new Date().toISOString()
        };
        socket.emit('trading:leaderboard', response);
        if (typeof ack === 'function') ack(response);
      } catch {
        const response = {
          ok: false,
          code: 'LEADERBOARD_FAILED',
          message: 'Unable to load leaderboard',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:stats', async (ack?: (response: any) => void) => {
      const socketData = socket.data as TradingSocketData;
      if (!socketData.userId) {
        const response = {
          ok: false,
          code: 'AUTH_REQUIRED',
          message: 'Login required to view trading stats',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
        return;
      }

      try {
        const stats = await getUserStats(socketData.userId);
        const response = {
          ok: true,
          stats,
          serverTime: new Date().toISOString()
        };
        socket.emit('trading:stats', response);
        if (typeof ack === 'function') ack(response);
      } catch {
        const response = {
          ok: false,
          code: 'STATS_FAILED',
          message: 'Unable to load trading stats',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:history', async (payload?: { cursor?: string; limit?: number }, ack?: (response: any) => void) => {
      const socketData = socket.data as TradingSocketData;
      if (!socketData.userId) {
        const response = {
          ok: false,
          code: 'AUTH_REQUIRED',
          message: 'Login required to view trading history',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
        return;
      }

      try {
        const history = await getHistory(socketData.userId, payload?.cursor, payload?.limit);
        const response = {
          ok: true,
          history,
          serverTime: new Date().toISOString()
        };
        socket.emit('trading:history', response);
        if (typeof ack === 'function') ack(response);
      } catch {
        const response = {
          ok: false,
          code: 'HISTORY_FAILED',
          message: 'Unable to load trading history',
          serverTime: new Date().toISOString()
        };
        if (typeof ack === 'function') ack(response);
        else emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:ping', (ack?: (payload: any) => void) => {
      const item = presence.get(socket.id);
      if (item) {
        item.lastPingAt = now();
        presence.set(socket.id, item);
      }

      const response = {
        ok: true,
        viewerCount: presence.size,
        serverTime: new Date().toISOString()
      };

      socket.emit('trading:pong', response);
      if (typeof ack === 'function') ack(response);
    });

    socket.on('disconnect', () => {
      presence.delete(socket.id);
      socket.leave('trading');
      if (userId) socket.leave(`user:${userId}`);
      broadcastPresence();
    });

    broadcastPresence();
  });

  const presenceTimer = setInterval(broadcastPresence, VIEWER_BROADCAST_MS);
  const heartbeatTimer = setInterval(() => {
    ns.to('trading').emit('trading:heartbeat', {
      serverTime: new Date().toISOString()
    });
  }, HEARTBEAT_MS);

  const shutdown = () => {
    clearInterval(presenceTimer);
    clearInterval(heartbeatTimer);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
