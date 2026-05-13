import Redis, { RedisOptions } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';

const NODE_ENV = process.env.NODE_ENV || 'development';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'texa:';
const REDIS_CONNECT_TIMEOUT = Number(process.env.REDIS_CONNECT_TIMEOUT || 10000);
const REDIS_COMMAND_TIMEOUT = Number(process.env.REDIS_COMMAND_TIMEOUT || 8000);
const REDIS_MAX_RETRIES = Number(process.env.REDIS_MAX_RETRIES || 3);

const baseRedisOptions: RedisOptions = {
  maxRetriesPerRequest: REDIS_MAX_RETRIES,
  retryStrategy: (times: number) => Math.min(times * 150, 5000),
  reconnectOnError: (err: Error) => {
    const message = err.message.toLowerCase();
    return (
      message.includes('readonly') ||
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('connection') ||
      message.includes('socket')
    );
  },
  enableReadyCheck: true,
  lazyConnect: true,
  showFriendlyErrorStack: NODE_ENV !== 'production',
  connectTimeout: REDIS_CONNECT_TIMEOUT,
  commandTimeout: REDIS_COMMAND_TIMEOUT,
  keepAlive: 30000,
  family: 4
};

export const redis = new Redis(REDIS_URL, {
  ...baseRedisOptions,
  keyPrefix: KEY_PREFIX
});

export const redisPub = new Redis(REDIS_URL, {
  ...baseRedisOptions,
  keyPrefix: ''
});

export const redisSub = new Redis(REDIS_URL, {
  ...baseRedisOptions,
  keyPrefix: ''
});

let adapterInitialized = false;
let listenersInitialized = false;
let shuttingDown = false;

type RedisJson =
  | string
  | number
  | boolean
  | null
  | RedisJson[]
  | { [key: string]: RedisJson };

type CachePrimitive = string | number | boolean | null;

function normalizeKey(key: string) {
  return key.replace(new RegExp(`^${KEY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').replace(/^texa:/, '');
}

function prefixKey(key: string) {
  return `${KEY_PREFIX}${normalizeKey(key)}`;
}

function serializeValue<T>(value: T): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function safeJsonParse<T>(value: string | null): T | null {
  if (value === null || value === undefined) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function isClientConnectable(client: Redis) {
  return client.status === 'wait' || client.status === 'end' || client.status === 'close';
}

function attachRedisListeners() {
  if (listenersInitialized) return;

  const clients: Array<[string, Redis]> = [
    ['Redis', redis],
    ['Redis Pub', redisPub],
    ['Redis Sub', redisSub]
  ];

  for (const [name, client] of clients) {
    client.on('error', err => console.error(`[${name} Error]`, err));
    client.on('connect', () => console.log(`[${name}] Connected`));
    client.on('ready', () => console.log(`[${name}] Ready`));
    client.on('reconnecting', () => console.log(`[${name}] Reconnecting`));
    client.on('end', () => console.log(`[${name}] Connection ended`));
  }

  listenersInitialized = true;
}

export async function connectRedis() {
  attachRedisListeners();

  const clients = [redis, redisPub, redisSub];

  await Promise.all(
    clients.map(async client => {
      if (isClientConnectable(client)) {
        await client.connect();
      }
    })
  );

  return true;
}

export function initRedisAdapter(io: Server) {
  attachRedisListeners();

  if (adapterInitialized) return;

  io.adapter(
    createAdapter(redisPub, redisSub, {
      requestsTimeout: Number(process.env.SOCKET_REDIS_REQUEST_TIMEOUT || 5000),
      publishOnSpecificResponseChannel: true
    })
  );

  adapterInitialized = true;
}

export async function redisHealthCheck() {
  try {
    const startedAt = Date.now();
    const result = await redis.ping();
    return {
      status: result === 'PONG' ? 'ok' : 'error',
      connected: result === 'PONG',
      latencyMs: Date.now() - startedAt,
      primary: redis.status,
      pub: redisPub.status,
      sub: redisSub.status,
      timestamp: new Date().toISOString()
    };
  } catch {
    return {
      status: 'error',
      connected: false,
      latencyMs: null,
      primary: redis.status,
      pub: redisPub.status,
      sub: redisSub.status,
      timestamp: new Date().toISOString()
    };
  }
}

export const redisKeys = {
  user: (id: string) => `user:${id}`,
  userProfile: (id: string) => `user:${id}:profile`,
  userSession: (id: string) => `user:${id}:session`,
  userDevices: (id: string) => `user:${id}:devices`,
  userNotifications: (id: string) => `user:${id}:notifications`,
  userPresence: (id: string) => `presence:user:${id}`,
  conversation: (id: string) => `conversation:${id}`,
  conversationMessages: (id: string) => `conversation:${id}:messages`,
  typing: (conversationId: string) => `typing:${conversationId}`,
  room: (id: string) => `room:${id}`,
  roomSeats: (id: string) => `room:${id}:seats`,
  roomListeners: (id: string) => `room:${id}:listeners`,
  roomPresence: (id: string) => `presence:room:${id}`,
  roomChat: (id: string) => `room:${id}:chat`,
  reel: (id: string) => `reel:${id}`,
  reelFeed: (userId: string) => `feed:reels:${userId}`,
  reelTrending: (region = 'global') => `trending:reels:${region}`,
  store: (id: string) => `store:${id}`,
  product: (id: string) => `product:${id}`,
  cart: (userId: string) => `cart:${userId}`,
  order: (id: string) => `order:${id}`,
  search: (query: string) => `search:${query}`,
  rate: (key: string) => `rate:${key}`,
  lock: (key: string) => `lock:${key}`,
  job: (id: string) => `job:${id}`
};

export const cache = {
  get: async <T>(key: string): Promise<T | null> => {
    const data = await redis.get(normalizeKey(key));
    return safeJsonParse<T>(data);
  },

  mget: async <T>(keys: string[]): Promise<Array<T | null>> => {
    if (!keys.length) return [];
    const data = await redis.mget(keys.map(normalizeKey));
    return data.map(item => safeJsonParse<T>(item));
  },

  set: async <T>(key: string, value: T, ttlSeconds?: number): Promise<'OK' | null> => {
    const serialized = serializeValue(value);
    const normalizedKey = normalizeKey(key);

    if (ttlSeconds && ttlSeconds > 0) {
      return redis.set(normalizedKey, serialized, 'EX', ttlSeconds);
    }

    return redis.set(normalizedKey, serialized);
  },

  setMany: async <T extends Record<string, unknown>>(values: T, ttlSeconds?: number): Promise<boolean> => {
    const pipeline = redis.pipeline();

    for (const [key, value] of Object.entries(values)) {
      const normalizedKey = normalizeKey(key);
      const serialized = serializeValue(value);

      if (ttlSeconds && ttlSeconds > 0) {
        pipeline.set(normalizedKey, serialized, 'EX', ttlSeconds);
      } else {
        pipeline.set(normalizedKey, serialized);
      }
    }

    const result = await pipeline.exec();
    return Boolean(result && result.every(([error]) => !error));
  },

  setNX: async <T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> => {
    const serialized = serializeValue(value);
    const normalizedKey = normalizeKey(key);

    const result =
      ttlSeconds && ttlSeconds > 0
        ? await redis.set(normalizedKey, serialized, 'EX', ttlSeconds, 'NX')
        : await redis.set(normalizedKey, serialized, 'NX');

    return result === 'OK';
  },

  remember: async <T>(
    key: string,
    ttlSeconds: number,
    resolver: () => Promise<T>
  ): Promise<T> => {
    const cached = await cache.get<T>(key);
    if (cached !== null) return cached;

    const lockToken = await cache.lock(`remember:${key}`, 8);

    if (!lockToken) {
      await new Promise(resolve => setTimeout(resolve, 120));
      const retryCached = await cache.get<T>(key);
      if (retryCached !== null) return retryCached;
      const fresh = await resolver();
      await cache.set(key, fresh, ttlSeconds);
      return fresh;
    }

    try {
      const secondCheck = await cache.get<T>(key);
      if (secondCheck !== null) return secondCheck;

      const fresh = await resolver();
      await cache.set(key, fresh, ttlSeconds);
      return fresh;
    } finally {
      await cache.unlock(`remember:${key}`, lockToken);
    }
  },

  delete: async (key: string): Promise<number> => {
    return redis.del(normalizeKey(key));
  },

  deleteMany: async (keys: string[]): Promise<number> => {
    if (!keys.length) return 0;
    return redis.del(keys.map(normalizeKey));
  },

  exists: async (key: string): Promise<boolean> => {
    const result = await redis.exists(normalizeKey(key));
    return result === 1;
  },

  expire: async (key: string, ttlSeconds: number): Promise<boolean> => {
    const result = await redis.expire(normalizeKey(key), ttlSeconds);
    return result === 1;
  },

  persist: async (key: string): Promise<boolean> => {
    const result = await redis.persist(normalizeKey(key));
    return result === 1;
  },

  ttl: async (key: string): Promise<number> => {
    return redis.ttl(normalizeKey(key));
  },

  touch: async (key: string): Promise<boolean> => {
    const result = await redis.touch(normalizeKey(key));
    return result === 1;
  },

  increment: async (key: string, by = 1, ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const result = await redis.incrby(normalizedKey, by);

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  decrement: async (key: string, by = 1, ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const result = await redis.decrby(normalizedKey, by);

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  hget: async <T>(key: string, field: string): Promise<T | null> => {
    const data = await redis.hget(normalizeKey(key), field);
    return safeJsonParse<T>(data);
  },

  hmget: async <T>(key: string, fields: string[]): Promise<Array<T | null>> => {
    if (!fields.length) return [];
    const data = await redis.hmget(normalizeKey(key), ...fields);
    return data.map(item => safeJsonParse<T>(item));
  },

  hgetAll: async <T = Record<string, unknown>>(key: string): Promise<T> => {
    const data = await redis.hgetall(normalizeKey(key));
    const parsed: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(data)) {
      parsed[field] = safeJsonParse(value);
    }

    return parsed as T;
  },

  hset: async <T>(key: string, field: string, value: T): Promise<number> => {
    return redis.hset(normalizeKey(key), field, serializeValue(value));
  },

  hmset: async <T extends Record<string, unknown>>(key: string, values: T): Promise<'OK'> => {
    const serialized: Record<string, string> = {};

    for (const [field, value] of Object.entries(values)) {
      serialized[field] = serializeValue(value);
    }

    return redis.hmset(normalizeKey(key), serialized);
  },

  hdel: async (key: string, fields: string | string[]): Promise<number> => {
    return redis.hdel(normalizeKey(key), ...(Array.isArray(fields) ? fields : [fields]));
  },

  hincrby: async (key: string, field: string, by = 1): Promise<number> => {
    return redis.hincrby(normalizeKey(key), field, by);
  },

  sadd: async <T>(key: string, value: T | T[], ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const values = Array.isArray(value) ? value : [value];
    const result = await redis.sadd(normalizedKey, values.map(v => serializeValue(v)));

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  srem: async <T>(key: string, value: T | T[]): Promise<number> => {
    const values = Array.isArray(value) ? value : [value];
    return redis.srem(normalizeKey(key), values.map(v => serializeValue(v)));
  },

  smembers: async <T>(key: string): Promise<T[]> => {
    const data = await redis.smembers(normalizeKey(key));
    return data.map(item => safeJsonParse<T>(item)).filter(item => item !== null) as T[];
  },

  sismember: async <T>(key: string, value: T): Promise<boolean> => {
    const result = await redis.sismember(normalizeKey(key), serializeValue(value));
    return result === 1;
  },

  scard: async (key: string): Promise<number> => {
    return redis.scard(normalizeKey(key));
  },

  lpush: async <T>(key: string, value: T | T[], ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const values = Array.isArray(value) ? value : [value];
    const result = await redis.lpush(normalizedKey, ...values.map(v => serializeValue(v)));

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  rpush: async <T>(key: string, value: T | T[], ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const values = Array.isArray(value) ? value : [value];
    const result = await redis.rpush(normalizedKey, ...values.map(v => serializeValue(v)));

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  lrange: async <T>(key: string, start = 0, stop = -1): Promise<T[]> => {
    const data = await redis.lrange(normalizeKey(key), start, stop);
    return data.map(item => safeJsonParse<T>(item)).filter(item => item !== null) as T[];
  },

  ltrim: async (key: string, start = 0, stop = -1): Promise<'OK'> => {
    return redis.ltrim(normalizeKey(key), start, stop);
  },

  zadd: async (key: string, score: number, member: string, ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const result = await redis.zadd(normalizedKey, score, member);

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  zaddMany: async (
    key: string,
    values: Array<{ score: number; member: string }>,
    ttlSeconds?: number
  ): Promise<number> => {
    if (!values.length) return 0;

    const normalizedKey = normalizeKey(key);
    const args = values.flatMap(item => [String(item.score), item.member]);
    const result = await redis.zadd(normalizedKey, ...args);

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  zrange: async (key: string, start = 0, stop = -1, reverse = false): Promise<string[]> => {
    return reverse
      ? redis.zrevrange(normalizeKey(key), start, stop)
      : redis.zrange(normalizeKey(key), start, stop);
  },

  zrangeWithScores: async (
    key: string,
    start = 0,
    stop = -1,
    reverse = false
  ): Promise<Array<{ member: string; score: number }>> => {
    const result = reverse
      ? await redis.zrevrange(normalizeKey(key), start, stop, 'WITHSCORES')
      : await redis.zrange(normalizeKey(key), start, stop, 'WITHSCORES');

    const items: Array<{ member: string; score: number }> = [];

    for (let i = 0; i < result.length; i += 2) {
      items.push({
        member: result[i],
        score: Number(result[i + 1])
      });
    }

    return items;
  },

  zrem: async (key: string, member: string | string[]): Promise<number> => {
    return redis.zrem(normalizeKey(key), ...(Array.isArray(member) ? member : [member]));
  },

  zscore: async (key: string, member: string): Promise<number | null> => {
    const score = await redis.zscore(normalizeKey(key), member);
    return score === null ? null : Number(score);
  },

  zcard: async (key: string): Promise<number> => {
    return redis.zcard(normalizeKey(key));
  },

  zrank: async (key: string, member: string, reverse = false): Promise<number | null> => {
    return reverse ? redis.zrevrank(normalizeKey(key), member) : redis.zrank(normalizeKey(key), member);
  },

  publish: async <T>(channel: string, payload: T): Promise<number> => {
    return redisPub.publish(prefixKey(channel), serializeValue(payload));
  },

  subscribe: async <T>(
    channel: string,
    handler: (payload: T, channel: string) => void
  ): Promise<void> => {
    const normalizedChannel = prefixKey(channel);

    await redisSub.subscribe(normalizedChannel);

    redisSub.on('message', (receivedChannel, message) => {
      if (receivedChannel !== normalizedChannel) return;
      handler(safeJsonParse<T>(message) as T, receivedChannel);
    });
  },

  unsubscribe: async (channel: string): Promise<void> => {
    await redisSub.unsubscribe(prefixKey(channel));
  },

  lock: async (key: string, ttlSeconds = 10): Promise<string | null> => {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}:${process.pid}`;
    const result = await redis.set(redisKeys.lock(key), token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  },

  unlock: async (key: string, token: string): Promise<boolean> => {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, redisKeys.lock(key), token);
    return result === 1;
  },

  rateLimit: async (
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number; current: number; limit: number }> => {
    const normalizedKey = redisKeys.rate(key);
    const pipeline = redis.pipeline();

    pipeline.incr(normalizedKey);
    pipeline.ttl(normalizedKey);

    const result = await pipeline.exec();

    const current = Number(result?.[0]?.[1] || 0);
    let ttl = Number(result?.[1]?.[1] || -1);

    if (current === 1 || ttl < 0) {
      await redis.expire(normalizedKey, windowSeconds);
      ttl = windowSeconds;
    }

    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetIn: ttl > 0 ? ttl : windowSeconds,
      current,
      limit
    };
  },

  slidingRateLimit: async (
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number; current: number; limit: number }> => {
    const normalizedKey = redisKeys.rate(`sliding:${key}`);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;
    const member = `${now}:${Math.random().toString(36).slice(2)}`;

    const pipeline = redis.pipeline();

    pipeline.zremrangebyscore(normalizedKey, 0, windowStart);
    pipeline.zadd(normalizedKey, now, member);
    pipeline.zcard(normalizedKey);
    pipeline.expire(normalizedKey, windowSeconds);

    const result = await pipeline.exec();
    const current = Number(result?.[2]?.[1] || 0);

    if (current > limit) {
      await redis.zrem(normalizedKey, member);
    }

    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetIn: windowSeconds,
      current,
      limit
    };
  },

  invalidatePattern: async (pattern: string): Promise<number> => {
    const match = prefixKey(pattern);
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
      cursor = nextCursor;

      if (keys.length > 0) {
        const normalizedKeys = keys.map(key => normalizeKey(key));
        deleted += await redis.del(normalizedKeys);
      }
    } while (cursor !== '0');

    return deleted;
  },

  flushTexaCache: async (): Promise<number> => {
    return cache.invalidatePattern('*');
  }
};

export const presence = {
  setUserOnline: async (userId: string, socketId: string, ttlSeconds = 90) => {
    const key = redisKeys.userPresence(userId);

    await cache.hmset(key, {
      userId,
      socketId,
      online: true,
      lastSeen: new Date().toISOString()
    });

    await cache.expire(key, ttlSeconds);
    return true;
  },

  setUserOffline: async (userId: string) => {
    await cache.delete(redisKeys.userPresence(userId));
    return true;
  },

  isUserOnline: async (userId: string) => {
    return cache.exists(redisKeys.userPresence(userId));
  },

  getUserPresence: async <T = Record<string, unknown>>(userId: string) => {
    return cache.hgetAll<T>(redisKeys.userPresence(userId));
  },

  joinRoom: async (roomId: string, userId: string, ttlSeconds = 120) => {
    await cache.sadd(redisKeys.roomPresence(roomId), userId, ttlSeconds);
    return true;
  },

  leaveRoom: async (roomId: string, userId: string) => {
    await cache.srem(redisKeys.roomPresence(roomId), userId);
    return true;
  },

  getRoomUsers: async (roomId: string) => {
    return cache.smembers<string>(redisKeys.roomPresence(roomId));
  },

  getRoomCount: async (roomId: string) => {
    return cache.scard(redisKeys.roomPresence(roomId));
  }
};

export const queues = {
  pushJob: async <T extends RedisJson>(queue: string, payload: T, ttlSeconds?: number) => {
    return cache.rpush(`queue:${queue}`, payload, ttlSeconds);
  },

  popJob: async <T>(queue: string): Promise<T | null> => {
    const item = await redis.lpop(normalizeKey(`queue:${queue}`));
    return safeJsonParse<T>(item);
  },

  queueSize: async (queue: string) => {
    return redis.llen(normalizeKey(`queue:${queue}`));
  }
};

export async function closeRedisConnections() {
  if (shuttingDown) return;
  shuttingDown = true;

  await Promise.allSettled([
    redis.quit(),
    redisPub.quit(),
    redisSub.quit()
  ]);
}

process.once('SIGINT', async () => {
  await closeRedisConnections();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  await closeRedisConnections();
  process.exit(0);
});

export default redis;
