import rateLimit, { Options, RateLimitRequestHandler, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response, NextFunction } from 'express';
import type { Server, Socket } from 'socket.io';
import { redis } from '../config/redis';

type LimitOptions = {
  windowMs: number;
  max: number;
  message: string;
  prefix: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
};

type SocketProtectionOptions = {
  connectionLimit?: number;
  connectionWindowSeconds?: number;
  eventLimit?: number;
  eventWindowSeconds?: number;
  heavyEventLimit?: number;
  heavyEventWindowSeconds?: number;
  disconnectOnFlood?: boolean;
};

const isProduction = process.env.NODE_ENV === 'production';

const safeNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const finalValue = Math.floor(parsed);
  if (typeof min === 'number' && finalValue < min) return min;
  if (typeof max === 'number' && finalValue > max) return max;
  return finalValue;
};

const hasRedis = () => {
  return !!redis && typeof (redis as any).call === 'function';
};

const redisStore = (prefix: string) => {
  if (!hasRedis()) return undefined;

  return new RedisStore({
    prefix: `rate:${prefix}:`,
    sendCommand: async (...args: string[]) => {
      return (redis as any).call(...args);
    }
  });
};

const getClientIp = (req: Request): string => {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ip = forwarded.split(',')[0]?.trim();
    if (ip) return ip;
  }

  if (Array.isArray(forwarded)) {
    const ip = forwarded[0]?.split(',')[0]?.trim();
    if (ip) return ip;
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
};

const keyGenerator = (req: Request): string => {
  const userId = (req as any).userId || (req as any).user?.id || (req as any).auth?.userId;
  const ip = getClientIp(req);
  return userId ? `user:${String(userId)}` : `ip:${ipKeyGenerator(ip)}`;
};

const handler = (_req: Request, res: Response, _next: NextFunction, options: Options) => {
  const retryAfter = res.getHeader('Retry-After');

  return res.status(options.statusCode || 429).json({
    success: false,
    error: typeof options.message === 'string' ? options.message : 'Too many requests. Please try again later.',
    message: typeof options.message === 'string' ? options.message : 'Too many requests. Please try again later.',
    retryAfter: retryAfter ? Number(retryAfter) || retryAfter : null
  });
};

const createLimiter = ({
  windowMs,
  max,
  message,
  prefix,
  skipSuccessfulRequests = false,
  skipFailedRequests = false
}: LimitOptions): RateLimitRequestHandler => {
  const store = redisStore(prefix);

  return rateLimit({
    store,
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    handler,
    message,
    skipSuccessfulRequests,
    skipFailedRequests
  });
};

export const apiLimiter = createLimiter({
  prefix: 'api',
  windowMs: safeNumber(process.env.API_LIMIT_WINDOW_MS, 15 * 60 * 1000, 1000),
  max: safeNumber(process.env.API_LIMIT_MAX, 300, 1),
  message: 'Too many requests. Please try again later.'
});

export const strictLimiter = createLimiter({
  prefix: 'strict',
  windowMs: safeNumber(process.env.STRICT_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.STRICT_LIMIT_MAX, 20, 1),
  message: 'Rate limit exceeded. Slow down.'
});

export const authLimiter = createLimiter({
  prefix: 'auth',
  windowMs: safeNumber(process.env.AUTH_LIMIT_WINDOW_MS, 15 * 60 * 1000, 1000),
  max: safeNumber(process.env.AUTH_LIMIT_MAX, 50, 1),
  message: 'Too many authentication attempts. Please try again later.',
  skipSuccessfulRequests: true
});

export const otpLimiter = createLimiter({
  prefix: 'otp',
  windowMs: safeNumber(process.env.OTP_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.OTP_LIMIT_MAX, 5, 1),
  message: 'Too many OTP requests. Please try again later.'
});

export const uploadLimiter = createLimiter({
  prefix: 'upload',
  windowMs: safeNumber(process.env.UPLOAD_LIMIT_WINDOW_MS, 5 * 60 * 1000, 1000),
  max: safeNumber(process.env.UPLOAD_LIMIT_MAX, 12, 1),
  message: 'Upload limit reached. Try again later.'
});

export const reelUploadLimiter = createLimiter({
  prefix: 'reel-upload',
  windowMs: safeNumber(process.env.REEL_UPLOAD_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.REEL_UPLOAD_LIMIT_MAX, 8, 1),
  message: 'Reel upload limit reached. Try again later.'
});

export const storyUploadLimiter = createLimiter({
  prefix: 'story-upload',
  windowMs: safeNumber(process.env.STORY_UPLOAD_LIMIT_WINDOW_MS, 5 * 60 * 1000, 1000),
  max: safeNumber(process.env.STORY_UPLOAD_LIMIT_MAX, 15, 1),
  message: 'Story upload limit reached. Try again later.'
});

export const commerceLimiter = createLimiter({
  prefix: 'commerce',
  windowMs: safeNumber(process.env.COMMERCE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.COMMERCE_LIMIT_MAX, 120, 1),
  message: 'Too many commerce requests. Please slow down.'
});

export const checkoutLimiter = createLimiter({
  prefix: 'checkout',
  windowMs: safeNumber(process.env.CHECKOUT_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.CHECKOUT_LIMIT_MAX, 20, 1),
  message: 'Checkout request limit reached. Please try again later.'
});

export const adminLimiter = createLimiter({
  prefix: 'admin',
  windowMs: safeNumber(process.env.ADMIN_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.ADMIN_LIMIT_MAX, 80, 1),
  message: 'Admin rate limit exceeded.'
});

export const searchLimiter = createLimiter({
  prefix: 'search',
  windowMs: safeNumber(process.env.SEARCH_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.SEARCH_LIMIT_MAX, 100, 1),
  message: 'Search limit reached. Please try again later.'
});

export const dmLimiter = createLimiter({
  prefix: 'dm',
  windowMs: safeNumber(process.env.DM_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.DM_LIMIT_MAX, 60, 1),
  message: 'Message limit reached. Please slow down.'
});

export const commentLimiter = createLimiter({
  prefix: 'comment',
  windowMs: safeNumber(process.env.COMMENT_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.COMMENT_LIMIT_MAX, 40, 1),
  message: 'Comment limit reached. Please slow down.'
});

export const reactionLimiter = createLimiter({
  prefix: 'reaction',
  windowMs: safeNumber(process.env.REACTION_LIMIT_WINDOW_MS, 30 * 1000, 1000),
  max: safeNumber(process.env.REACTION_LIMIT_MAX, 120, 1),
  message: 'Reaction limit reached. Please slow down.'
});

export const voiceRoomLimiter = createLimiter({
  prefix: 'voice-room',
  windowMs: safeNumber(process.env.VOICE_ROOM_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.VOICE_ROOM_LIMIT_MAX, 80, 1),
  message: 'Voice room limit reached. Please slow down.'
});

export const tradingLimiter = createLimiter({
  prefix: 'trading',
  windowMs: safeNumber(process.env.TRADING_LIMIT_WINDOW_MS, 30 * 1000, 1000),
  max: safeNumber(process.env.TRADING_LIMIT_MAX, 60, 1),
  message: 'Trading request limit reached. Please slow down.'
});

export const paymentLimiter = createLimiter({
  prefix: 'payment',
  windowMs: safeNumber(process.env.PAYMENT_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.PAYMENT_LIMIT_MAX, 30, 1),
  message: 'Payment request limit reached. Please try again later.'
});

export const aiLimiter = createLimiter({
  prefix: 'ai',
  windowMs: safeNumber(process.env.AI_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.AI_LIMIT_MAX, 30, 1),
  message: 'AI request limit reached. Please slow down.'
});

export const createDynamicLimiter = (options: LimitOptions): RateLimitRequestHandler => createLimiter(options);

const getSocketIp = (socket: Socket): string => {
  const cfIp = socket.handshake.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  const realIp = socket.handshake.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const ip = forwarded.split(',')[0]?.trim();
    if (ip) return ip;
  }

  if (Array.isArray(forwarded)) {
    const ip = forwarded[0]?.split(',')[0]?.trim();
    if (ip) return ip;
  }

  return socket.handshake.address || 'unknown';
};

const socketKey = (socket: Socket, scope: string): string => {
  const userId = socket.data?.userId || socket.handshake.auth?.userId || socket.handshake.query?.userId;
  const ip = getSocketIp(socket);
  return userId ? `socket:${scope}:user:${String(userId)}` : `socket:${scope}:ip:${ip}`;
};

const memoryHits = new Map<string, { count: number; expiresAt: number }>();

const hitMemoryLimit = (key: string, limit: number, ttlSeconds: number): boolean => {
  const now = Date.now();
  const current = memoryHits.get(key);

  if (!current || current.expiresAt <= now) {
    memoryHits.set(key, {
      count: 1,
      expiresAt: now + ttlSeconds * 1000
    });
    return false;
  }

  current.count += 1;
  memoryHits.set(key, current);
  return current.count > limit;
};

const hitSocketLimit = async (key: string, limit: number, ttlSeconds: number): Promise<boolean> => {
  if (!hasRedis()) {
    return hitMemoryLimit(key, limit, ttlSeconds);
  }

  const count = await (redis as any).incr(key);
  if (count === 1) await (redis as any).expire(key, ttlSeconds);
  return Number(count) > limit;
};

const socketGet = async (key: string) => {
  if (!hasRedis()) {
    const item = memoryHits.get(key);
    if (!item || item.expiresAt <= Date.now()) return null;
    return String(item.count);
  }

  return (redis as any).get(key);
};

const socketSetBlocked = async (key: string, ttlSeconds: number) => {
  if (!hasRedis()) {
    memoryHits.set(key, {
      count: 1,
      expiresAt: Date.now() + ttlSeconds * 1000
    });
    return;
  }

  await (redis as any).set(key, '1', 'EX', ttlSeconds);
};

const cleanupMemoryHits = () => {
  const now = Date.now();
  for (const [key, value] of memoryHits.entries()) {
    if (value.expiresAt <= now) {
      memoryHits.delete(key);
    }
  }
};

setInterval(cleanupMemoryHits, 60 * 1000).unref?.();

export const socketFloodProtection = (
  io: Server,
  options: SocketProtectionOptions = {}
) => {
  const connectionLimit = options.connectionLimit ?? safeNumber(process.env.SOCKET_CONNECTION_LIMIT, 120, 1);
  const connectionWindowSeconds = options.connectionWindowSeconds ?? safeNumber(process.env.SOCKET_CONNECTION_WINDOW_SECONDS, 60, 1);
  const eventLimit = options.eventLimit ?? safeNumber(process.env.SOCKET_EVENT_LIMIT, 240, 1);
  const eventWindowSeconds = options.eventWindowSeconds ?? safeNumber(process.env.SOCKET_EVENT_WINDOW_SECONDS, 60, 1);
  const heavyEventLimit = options.heavyEventLimit ?? safeNumber(process.env.SOCKET_HEAVY_EVENT_LIMIT, 40, 1);
  const heavyEventWindowSeconds = options.heavyEventWindowSeconds ?? safeNumber(process.env.SOCKET_HEAVY_EVENT_WINDOW_SECONDS, 60, 1);
  const disconnectOnFlood = options.disconnectOnFlood ?? true;

  io.use(async (socket: Socket, next) => {
    try {
      const key = socketKey(socket, 'connect');
      const blockedKey = `${key}:blocked`;
      const blocked = await socketGet(blockedKey);

      if (blocked) {
        return next(new Error('Socket temporarily blocked'));
      }

      const limited = await hitSocketLimit(key, connectionLimit, connectionWindowSeconds);

      if (limited) {
        await socketSetBlocked(blockedKey, 5 * 60);
        return next(new Error('Socket flood detected'));
      }

      return next();
    } catch (error) {
      if (isProduction) return next(new Error('Socket protection unavailable'));
      return next(error as Error);
    }
  });

  io.on('connection', (socket: Socket) => {
    socket.use(async (packet, next) => {
      try {
        const eventName = String(packet[0] || 'unknown').slice(0, 120);
        const lowerEvent = eventName.toLowerCase();

        const isHeavyEvent =
          lowerEvent.includes('upload') ||
          lowerEvent.includes('create') ||
          lowerEvent.includes('send') ||
          lowerEvent.includes('comment') ||
          lowerEvent.includes('message') ||
          lowerEvent.includes('checkout') ||
          lowerEvent.includes('order') ||
          lowerEvent.includes('trade') ||
          lowerEvent.includes('watching') ||
          lowerEvent.includes('stream') ||
          lowerEvent.includes('voice') ||
          lowerEvent.includes('room') ||
          lowerEvent.includes('payment');

        const scope = isHeavyEvent ? 'heavy-event' : 'event';
        const limit = isHeavyEvent ? heavyEventLimit : eventLimit;
        const ttl = isHeavyEvent ? heavyEventWindowSeconds : eventWindowSeconds;
        const key = `${socketKey(socket, scope)}:${eventName}`;
        const limited = await hitSocketLimit(key, limit, ttl);

        if (limited) {
          socket.emit('rate_limit:blocked', {
            event: eventName,
            retryAfter: ttl,
            message: 'Too many socket events. Please slow down.'
          });

          if (disconnectOnFlood) {
            socket.disconnect(true);
          }

          return;
        }

        return next();
      } catch (error) {
        if (isProduction) return next(new Error('Socket rate protection failed'));
        return next(error as Error);
      }
    });
  });
};

export const clearRateLimitKey = async (key: string) => {
  if (!key) return;

  if (!hasRedis()) {
    memoryHits.delete(key);
    return;
  }

  await (redis as any).del(key);
};

export const getRateLimitStatus = async (key: string) => {
  if (!key) {
    return {
      key,
      count: 0,
      ttl: -1
    };
  }

  if (!hasRedis()) {
    const item = memoryHits.get(key);
    if (!item || item.expiresAt <= Date.now()) {
      return {
        key,
        count: 0,
        ttl: -1
      };
    }

    return {
      key,
      count: item.count,
      ttl: Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000))
    };
  }

  const [count, ttl] = await Promise.all([(redis as any).get(key), (redis as any).ttl(key)]);

  return {
    key,
    count: Number(count || 0),
    ttl: Number(ttl)
  };
};

export const resetUserRateLimits = async (userId: string) => {
  if (!userId) return { cleared: 0 };

  if (!hasRedis()) {
    let cleared = 0;
    for (const key of memoryHits.keys()) {
      if (key.includes(`user:${userId}`)) {
        memoryHits.delete(key);
        cleared += 1;
      }
    }
    return { cleared };
  }

  const patterns = [
    `rate:*:user:${userId}*`,
    `socket:*:user:${userId}*`
  ];

  let cleared = 0;

  for (const pattern of patterns) {
    let cursor = '0';

    do {
      const result = await (redis as any).scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = String(result[0]);
      const keys = result[1] || [];

      if (keys.length) {
        await (redis as any).del(...keys);
        cleared += keys.length;
      }
    } while (cursor !== '0');
  }

  return { cleared };
};
