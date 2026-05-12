import rateLimit, { Options, RateLimitRequestHandler } from 'express-rate-limit';
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

const isProduction = process.env.NODE_ENV === 'production';

const redisStore = (prefix: string) =>
  new RedisStore({
    prefix: `rate:${prefix}:`,
    sendCommand: async (...args: string[]) => redis.call(...args)
  });

const getClientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  if (Array.isArray(forwarded)) return forwarded[0]?.split(',')[0]?.trim() || req.ip || 'unknown';
  return req.ip || req.socket.remoteAddress || 'unknown';
};

const keyGenerator = (req: Request): string => {
  const userId = (req as any).userId || (req as any).user?.id;
  const ip = getClientIp(req);
  return userId ? `user:${userId}` : `ip:${ip}`;
};

const handler = (_req: Request, res: Response, _next: NextFunction, options: Options) => {
  res.status(options.statusCode || 429).json({
    success: false,
    error: typeof options.message === 'string' ? options.message : 'Too many requests. Please try again later.',
    retryAfter: res.getHeader('Retry-After') || null
  });
};

const createLimiter = ({
  windowMs,
  max,
  message,
  prefix,
  skipSuccessfulRequests = false,
  skipFailedRequests = false
}: LimitOptions): RateLimitRequestHandler =>
  rateLimit({
    store: redisStore(prefix),
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

export const apiLimiter = createLimiter({
  prefix: 'api',
  windowMs: Number(process.env.API_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.API_LIMIT_MAX || 300),
  message: 'Too many requests. Please try again later.'
});

export const strictLimiter = createLimiter({
  prefix: 'strict',
  windowMs: Number(process.env.STRICT_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.STRICT_LIMIT_MAX || 20),
  message: 'Rate limit exceeded. Slow down.'
});

export const authLimiter = createLimiter({
  prefix: 'auth',
  windowMs: Number(process.env.AUTH_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_LIMIT_MAX || 50),
  message: 'Too many authentication attempts. Please try again later.',
  skipSuccessfulRequests: true
});

export const otpLimiter = createLimiter({
  prefix: 'otp',
  windowMs: Number(process.env.OTP_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.OTP_LIMIT_MAX || 5),
  message: 'Too many OTP requests. Please try again later.'
});

export const uploadLimiter = createLimiter({
  prefix: 'upload',
  windowMs: Number(process.env.UPLOAD_LIMIT_WINDOW_MS || 5 * 60 * 1000),
  max: Number(process.env.UPLOAD_LIMIT_MAX || 12),
  message: 'Upload limit reached. Try again later.'
});

export const reelUploadLimiter = createLimiter({
  prefix: 'reel-upload',
  windowMs: Number(process.env.REEL_UPLOAD_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.REEL_UPLOAD_LIMIT_MAX || 8),
  message: 'Reel upload limit reached. Try again later.'
});

export const storyUploadLimiter = createLimiter({
  prefix: 'story-upload',
  windowMs: Number(process.env.STORY_UPLOAD_LIMIT_WINDOW_MS || 5 * 60 * 1000),
  max: Number(process.env.STORY_UPLOAD_LIMIT_MAX || 15),
  message: 'Story upload limit reached. Try again later.'
});

export const commerceLimiter = createLimiter({
  prefix: 'commerce',
  windowMs: Number(process.env.COMMERCE_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.COMMERCE_LIMIT_MAX || 120),
  message: 'Too many commerce requests. Please slow down.'
});

export const checkoutLimiter = createLimiter({
  prefix: 'checkout',
  windowMs: Number(process.env.CHECKOUT_LIMIT_WINDOW_MS || 10 * 60 * 1000),
  max: Number(process.env.CHECKOUT_LIMIT_MAX || 20),
  message: 'Checkout request limit reached. Please try again later.'
});

export const adminLimiter = createLimiter({
  prefix: 'admin',
  windowMs: Number(process.env.ADMIN_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.ADMIN_LIMIT_MAX || 80),
  message: 'Admin rate limit exceeded.'
});

export const searchLimiter = createLimiter({
  prefix: 'search',
  windowMs: Number(process.env.SEARCH_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.SEARCH_LIMIT_MAX || 100),
  message: 'Search limit reached. Please try again later.'
});

export const dmLimiter = createLimiter({
  prefix: 'dm',
  windowMs: Number(process.env.DM_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.DM_LIMIT_MAX || 60),
  message: 'Message limit reached. Please slow down.'
});

export const commentLimiter = createLimiter({
  prefix: 'comment',
  windowMs: Number(process.env.COMMENT_LIMIT_WINDOW_MS || 60 * 1000),
  max: Number(process.env.COMMENT_LIMIT_MAX || 40),
  message: 'Comment limit reached. Please slow down.'
});

export const reactionLimiter = createLimiter({
  prefix: 'reaction',
  windowMs: Number(process.env.REACTION_LIMIT_WINDOW_MS || 30 * 1000),
  max: Number(process.env.REACTION_LIMIT_MAX || 120),
  message: 'Reaction limit reached. Please slow down.'
});

export const createDynamicLimiter = (options: LimitOptions): RateLimitRequestHandler => createLimiter(options);

const getSocketIp = (socket: Socket): string => {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || socket.handshake.address || 'unknown';
  if (Array.isArray(forwarded)) return forwarded[0]?.split(',')[0]?.trim() || socket.handshake.address || 'unknown';
  return socket.handshake.address || 'unknown';
};

const socketKey = (socket: Socket, scope: string): string => {
  const userId = socket.data?.userId;
  const ip = getSocketIp(socket);
  return userId ? `socket:${scope}:user:${userId}` : `socket:${scope}:ip:${ip}`;
};

const hitSocketLimit = async (key: string, limit: number, ttlSeconds: number): Promise<boolean> => {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count > limit;
};

export const socketFloodProtection = (
  io: Server,
  options: {
    connectionLimit?: number;
    connectionWindowSeconds?: number;
    eventLimit?: number;
    eventWindowSeconds?: number;
    heavyEventLimit?: number;
    heavyEventWindowSeconds?: number;
    disconnectOnFlood?: boolean;
  } = {}
) => {
  const connectionLimit = options.connectionLimit ?? Number(process.env.SOCKET_CONNECTION_LIMIT || 120);
  const connectionWindowSeconds = options.connectionWindowSeconds ?? Number(process.env.SOCKET_CONNECTION_WINDOW_SECONDS || 60);
  const eventLimit = options.eventLimit ?? Number(process.env.SOCKET_EVENT_LIMIT || 240);
  const eventWindowSeconds = options.eventWindowSeconds ?? Number(process.env.SOCKET_EVENT_WINDOW_SECONDS || 60);
  const heavyEventLimit = options.heavyEventLimit ?? Number(process.env.SOCKET_HEAVY_EVENT_LIMIT || 40);
  const heavyEventWindowSeconds = options.heavyEventWindowSeconds ?? Number(process.env.SOCKET_HEAVY_EVENT_WINDOW_SECONDS || 60);
  const disconnectOnFlood = options.disconnectOnFlood ?? true;

  io.use(async (socket: Socket, next) => {
    try {
      const key = socketKey(socket, 'connect');
      const blockedKey = `${key}:blocked`;
      const blocked = await redis.get(blockedKey);

      if (blocked) return next(new Error('Socket temporarily blocked'));

      const limited = await hitSocketLimit(key, connectionLimit, connectionWindowSeconds);

      if (limited) {
        await redis.set(blockedKey, '1', 'EX', 5 * 60);
        return next(new Error('Socket flood detected'));
      }

      next();
    } catch (error) {
      if (isProduction) return next(new Error('Socket protection unavailable'));
      next(error as Error);
    }
  });

  io.on('connection', (socket: Socket) => {
    socket.use(async (packet, next) => {
      try {
        const eventName = String(packet[0] || 'unknown');
        const isHeavyEvent =
          eventName.includes('upload') ||
          eventName.includes('create') ||
          eventName.includes('send') ||
          eventName.includes('comment') ||
          eventName.includes('message') ||
          eventName.includes('checkout') ||
          eventName.includes('order') ||
          eventName.includes('trade') ||
          eventName.includes('watching');

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

          if (disconnectOnFlood) socket.disconnect(true);
          return;
        }

        next();
      } catch (error) {
        if (isProduction) return next(new Error('Socket rate protection failed'));
        next(error as Error);
      }
    });
  });
};

export const clearRateLimitKey = async (key: string) => {
  await redis.del(key);
};

export const getRateLimitStatus = async (key: string) => {
  const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  return {
    key,
    count: Number(count || 0),
    ttl
  };
};
