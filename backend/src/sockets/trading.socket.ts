import { Server, Socket, Namespace } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';

type TradingSocketData = {
  userId?: string;
  deviceId?: string;
  connectedAt: number;
  lastPingAt: number;
  lastSubscribeAt?: number;
  lastRefreshAt?: number;
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

type Ack<T = any> = (response: T) => void;

const PRESENCE_TTL_MS = 45_000;
const SUBSCRIBE_COOLDOWN_MS = 1_200;
const REFRESH_COOLDOWN_MS = 900;
const VIEWER_BROADCAST_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const MAX_LIMIT = 50;
const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 90;

const tradingIntervals = new WeakMap<Server, { presenceTimer: NodeJS.Timeout; heartbeatTimer: NodeJS.Timeout }>();
const socketBuckets = new Map<string, { count: number; resetAt: number }>();

function now() {
  return Date.now();
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

function clampLimit(value: any, fallback = 20) {
  const n = safeNumber(value, fallback);
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function isValidId(value: any) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function safeAck(ack: unknown, response: any) {
  if (typeof ack === 'function') {
    try {
      (ack as Ack)(response);
    } catch {}
  }
}

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET || '';
}

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const header = socket.handshake.headers?.authorization;
  const queryToken = socket.handshake.query?.token;

  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return null;
}

async function resolveUser(socket: Socket) {
  const token = getToken(socket);
  const secret = getJwtSecret();

  if (!token || !secret) return null;

  try {
    const decoded = jwt.verify(token, secret) as { userId?: string; id?: string; sub?: string; role?: string };
    const userId = decoded.userId || decoded.id || decoded.sub || null;

    if (!userId || !isValidId(userId)) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        isBanned: true
      } as any
    }).catch(() => null);

    if (!user || (user as any).isBanned) return null;

    return {
      userId: user.id,
      role: String((user as any).role || decoded.role || 'USER')
    };
  } catch {
    return null;
  }
}

function sanitizeChoice(choice: TradingChoice, userId?: string) {
  const votes = safeNumber(choice.votes);
  const investments = safeNumber(choice.investments);
  const voters = Array.isArray(choice.voters) ? choice.voters.filter(Boolean) : [];
  const investors = Array.isArray(choice.investors) ? choice.investors.filter(Boolean) : [];

  return {
    id: String(choice.id || ''),
    text: String(choice.text || ''),
    iconKey: choice.iconKey || null,
    color: choice.color || null,
    gradient: Array.isArray(choice.gradient) ? choice.gradient.filter(item => typeof item === 'string') : [],
    category: choice.category || null,
    votes,
    investments,
    votePercent: 0,
    investmentPercent: 0,
    selectedByMe: userId ? voters.includes(userId) : false,
    investedByMe: userId ? investors.includes(userId) : false
  };
}

async function buildTradingPayload(userId?: string, viewerCount = 0) {
  const day = await prisma.tradingDay.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' }
  });

  if (!day) {
    return {
      ok: true,
      isActive: false,
      serverTime: new Date().toISOString(),
      viewerCount,
      day: null,
      myInvestment: null
    };
  }

  const rawChoices = Array.isArray(day.choices) ? (day.choices as TradingChoice[]) : [];
  const totalVotes = rawChoices.reduce((sum, choice) => sum + safeNumber(choice.votes), 0);
  const totalInvestments = rawChoices.reduce((sum, choice) => sum + safeNumber(choice.investments), 0);

  const choices = rawChoices.map(choice => {
    const item = sanitizeChoice(choice, userId);

    return {
      ...item,
      votePercent: totalVotes > 0 ? round((item.votes / totalVotes) * 100) : 0,
      investmentPercent: totalInvestments > 0 ? round((item.investments / totalInvestments) * 100) : 0
    };
  });

  const myInvestment = userId
    ? await prisma.tradeInvestment.findFirst({
        where: {
          dayId: day.id,
          userId,
          status: { in: ['active', 'pending'] }
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          choiceId: true,
          amount: true,
          status: true,
          payout: true,
          createdAt: true
        }
      }).catch(() => null)
    : null;

  return {
    ok: true,
    isActive: true,
    serverTime: new Date().toISOString(),
    viewerCount,
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
          fullName: true,
          avatarUrl: true,
          isVerified: true
        } as any
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
      where: {
        userId,
        status: { in: ['active', 'pending'] }
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        dayId: true,
        choiceId: true,
        amount: true,
        status: true,
        payout: true,
        createdAt: true,
        day: {
          select: {
            id: true,
            title: true,
            date: true,
            lockedAt: true,
            resolvedAt: true,
            winnerChoice: true
          }
        }
      }
    }).catch(() => null),
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
    }).catch(() => null)
  ]);

  const totalInvested = safeNumber(aggregate._sum.amount);
  const totalPayout = safeNumber(aggregate._sum.payout);
  const settled = wins + losses;

  return {
    totalInvested,
    totalPayout,
    profit: totalPayout - totalInvested,
    trades: safeNumber(aggregate._count),
    wins,
    losses,
    winRate: settled > 0 ? round((wins / settled) * 100) : 0,
    bestPayout: safeNumber(aggregate._max.payout, safeNumber(leaderboard?.bestPayout)),
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
    cursor: cursor && isValidId(cursor) ? { id: cursor } : undefined,
    skip: cursor && isValidId(cursor) ? 1 : 0,
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

function emitError(socket: Socket, code: string, message: string, meta?: any) {
  socket.emit('trading:error', {
    ok: false,
    code,
    message,
    meta: meta || null,
    serverTime: new Date().toISOString()
  });
}

function makeError(code: string, message: string, meta?: any) {
  return {
    ok: false,
    code,
    message,
    meta: meta || null,
    serverTime: new Date().toISOString()
  };
}

function rateLimit(socket: Socket) {
  const current = now();
  const bucket = socketBuckets.get(socket.id);

  if (!bucket || bucket.resetAt <= current) {
    socketBuckets.set(socket.id, {
      count: 1,
      resetAt: current + SOCKET_RATE_LIMIT_WINDOW
    });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= SOCKET_RATE_LIMIT_MAX;
}

function bindRateLimit(socket: Socket) {
  socket.use((packet, next) => {
    if (!rateLimit(socket)) {
      emitError(socket, 'RATE_LIMITED', 'Too many socket events');
      return;
    }

    next();
  });
}

function getPresencePayload(presence: Map<string, TradingSocketData>) {
  const current = now();

  for (const [id, data] of presence.entries()) {
    if (current - data.lastPingAt > PRESENCE_TTL_MS) {
      presence.delete(id);
    }
  }

  const authenticatedCount = Array.from(presence.values()).filter(item => item.userId).length;

  return {
    viewerCount: presence.size,
    authenticatedCount,
    serverTime: new Date().toISOString()
  };
}

async function emitTradingSnapshot(ns: Namespace, presence: Map<string, TradingSocketData>, userId?: string, socket?: Socket) {
  const payload = await buildTradingPayload(userId, presence.size);

  if (socket) {
    socket.emit('trading:init', payload);
  } else {
    ns.to('trading').emit('trading:update', payload);
  }

  return payload;
}

export function initTradingSockets(io: Server) {
  const ns = io.of('/trading');
  const presence = new Map<string, TradingSocketData>();

  const broadcastPresence = () => {
    const payload = getPresencePayload(presence);
    ns.to('trading').emit('trading:presence', payload);
  };

  ns.use(async (socket: Socket, next) => {
    const resolved = await resolveUser(socket);

    socket.data.userId = resolved?.userId || undefined;
    socket.data.role = resolved?.role || undefined;
    socket.data.deviceId = typeof socket.handshake.auth?.deviceId === 'string' ? socket.handshake.auth.deviceId.trim().slice(0, 128) : undefined;
    socket.data.connectedAt = now();
    socket.data.lastPingAt = now();

    next();
  });

  ns.on('connection', async (socket: Socket) => {
    const data = socket.data as TradingSocketData;
    const userId = data.userId;

    bindRateLimit(socket);

    socket.join('trading');

    if (userId) {
      socket.join(`user:${userId}`);
    }

    presence.set(socket.id, {
      userId,
      deviceId: data.deviceId,
      connectedAt: now(),
      lastPingAt: now()
    });

    socket.emit('trading:connected', {
      ok: true,
      socketId: socket.id,
      authenticated: Boolean(userId),
      viewerCount: presence.size,
      serverTime: new Date().toISOString()
    });

    try {
      await emitTradingSnapshot(ns, presence, userId, socket);
    } catch {
      emitError(socket, 'INIT_FAILED', 'Unable to load trading battle right now');
    }

    socket.on('trading:subscribe', async (ack?: Ack) => {
      const socketData = socket.data as TradingSocketData;
      const current = now();

      if (socketData.lastSubscribeAt && current - socketData.lastSubscribeAt < SUBSCRIBE_COOLDOWN_MS) {
        const response = makeError('RATE_LIMITED', 'Please wait before refreshing again');
        safeAck(ack, response);
        return emitError(socket, response.code, response.message);
      }

      socketData.lastSubscribeAt = current;
      socket.join('trading');

      try {
        const response = await emitTradingSnapshot(ns, presence, socketData.userId, socket);
        safeAck(ack, response);
      } catch {
        const response = makeError('SUBSCRIBE_FAILED', 'Unable to subscribe to trading battle');
        safeAck(ack, response);
        emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:unsubscribe', (ack?: Ack) => {
      socket.leave('trading');

      const response = {
        ok: true,
        serverTime: new Date().toISOString()
      };

      socket.emit('trading:unsubscribed', response);
      safeAck(ack, response);
    });

    socket.on('trading:refresh', async (ack?: Ack) => {
      const socketData = socket.data as TradingSocketData;
      const current = now();

      if (socketData.lastRefreshAt && current - socketData.lastRefreshAt < REFRESH_COOLDOWN_MS) {
        const response = makeError('RATE_LIMITED', 'Please wait before refreshing again');
        safeAck(ack, response);
        return;
      }

      socketData.lastRefreshAt = current;

      try {
        const response = await emitTradingSnapshot(ns, presence, socketData.userId, socket);
        safeAck(ack, response);
      } catch {
        const response = makeError('REFRESH_FAILED', 'Unable to refresh trading battle');
        safeAck(ack, response);
        emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:leaderboard', async (payload?: { limit?: number }, ack?: Ack) => {
      try {
        const leaderboard = await getLeaderboard(clampLimit(payload?.limit, 50));

        const response = {
          ok: true,
          leaderboard,
          serverTime: new Date().toISOString()
        };

        socket.emit('trading:leaderboard', response);
        safeAck(ack, response);
      } catch {
        const response = makeError('LEADERBOARD_FAILED', 'Unable to load leaderboard');
        safeAck(ack, response);
        emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:stats', async (ack?: Ack) => {
      const socketData = socket.data as TradingSocketData;

      if (!socketData.userId) {
        const response = makeError('AUTH_REQUIRED', 'Login required to view trading stats');
        safeAck(ack, response);
        return emitError(socket, response.code, response.message);
      }

      try {
        const stats = await getUserStats(socketData.userId);

        const response = {
          ok: true,
          stats,
          serverTime: new Date().toISOString()
        };

        socket.emit('trading:stats', response);
        safeAck(ack, response);
      } catch {
        const response = makeError('STATS_FAILED', 'Unable to load trading stats');
        safeAck(ack, response);
        emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:history', async (payload?: { cursor?: string; limit?: number }, ack?: Ack) => {
      const socketData = socket.data as TradingSocketData;

      if (!socketData.userId) {
        const response = makeError('AUTH_REQUIRED', 'Login required to view trading history');
        safeAck(ack, response);
        return emitError(socket, response.code, response.message);
      }

      try {
        const history = await getHistory(socketData.userId, payload?.cursor, payload?.limit);

        const response = {
          ok: true,
          history,
          serverTime: new Date().toISOString()
        };

        socket.emit('trading:history', response);
        safeAck(ack, response);
      } catch {
        const response = makeError('HISTORY_FAILED', 'Unable to load trading history');
        safeAck(ack, response);
        emitError(socket, response.code, response.message);
      }
    });

    socket.on('trading:ping', (ack?: Ack) => {
      const item = presence.get(socket.id);

      if (item) {
        item.lastPingAt = now();
        presence.set(socket.id, item);
      }

      const response = {
        ok: true,
        ...getPresencePayload(presence)
      };

      socket.emit('trading:pong', response);
      safeAck(ack, response);
    });

    socket.on('disconnect', () => {
      presence.delete(socket.id);
      socketBuckets.delete(socket.id);
      socket.leave('trading');

      if (userId) {
        socket.leave(`user:${userId}`);
      }

      broadcastPresence();
    });

    broadcastPresence();
  });

  if (!tradingIntervals.has(io)) {
    const presenceTimer = setInterval(broadcastPresence, VIEWER_BROADCAST_MS);

    const heartbeatTimer = setInterval(() => {
      ns.to('trading').emit('trading:heartbeat', {
        ok: true,
        ...getPresencePayload(presence)
      });
    }, HEARTBEAT_MS);

    tradingIntervals.set(io, {
      presenceTimer,
      heartbeatTimer
    });

    const shutdown = () => {
      const timers = tradingIntervals.get(io);

      if (timers) {
        clearInterval(timers.presenceTimer);
        clearInterval(timers.heartbeatTimer);
        tradingIntervals.delete(io);
      }
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  return ns;
}

export async function emitTradingUpdated(io: Server, userId?: string) {
  const ns = io.of('/trading');
  const payload = await buildTradingPayload(userId);

  if (userId) {
    ns.to(`user:${userId}`).emit('trading:update', payload);
  } else {
    ns.to('trading').emit('trading:update', payload);
  }

  return payload;
}

export async function emitTradingResolved(io: Server) {
  const ns = io.of('/trading');
  const payload = await buildTradingPayload();

  ns.to('trading').emit('trading:resolved', payload);

  return payload;
}

export async function emitTradingLeaderboardUpdated(io: Server, limit = 50) {
  const ns = io.of('/trading');
  const leaderboard = await getLeaderboard(clampLimit(limit, 50));

  const payload = {
    ok: true,
    leaderboard,
    serverTime: new Date().toISOString()
  };

  ns.to('trading').emit('trading:leaderboard:update', payload);

  return payload;
}
