import Redis, { RedisOptions } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'texa:';

const baseRedisOptions: RedisOptions = {
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
  reconnectOnError: (err: Error) => {
    const message = err.message.toLowerCase();
    return message.includes('readonly') || message.includes('etimedout') || message.includes('econnreset');
  },
  enableReadyCheck: true,
  lazyConnect: true,
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
  connectTimeout: 10000,
  commandTimeout: 8000,
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

export async function connectRedis() {
  const clients = [redis, redisPub, redisSub];

  await Promise.all(
    clients.map(async client => {
      if (client.status === 'wait' || client.status === 'end') {
        await client.connect();
      }
    })
  );

  return true;
}

export function initRedisAdapter(io: Server) {
  if (adapterInitialized) return;

  io.adapter(createAdapter(redisPub, redisSub));

  redis.on('error', err => console.error('[Redis Error]', err));
  redisPub.on('error', err => console.error('[Redis Pub Error]', err));
  redisSub.on('error', err => console.error('[Redis Sub Error]', err));

  redis.on('connect', () => console.log('[Redis] Connected'));
  redisPub.on('connect', () => console.log('[Redis Pub] Connected'));
  redisSub.on('connect', () => console.log('[Redis Sub] Connected'));

  redis.on('ready', () => console.log('[Redis] Ready'));
  redisPub.on('ready', () => console.log('[Redis Pub] Ready'));
  redisSub.on('ready', () => console.log('[Redis Sub] Ready'));

  redis.on('reconnecting', () => console.log('[Redis] Reconnecting'));
  redisPub.on('reconnecting', () => console.log('[Redis Pub] Reconnecting'));
  redisSub.on('reconnecting', () => console.log('[Redis Sub] Reconnecting'));

  redis.on('end', () => console.log('[Redis] Connection ended'));
  redisPub.on('end', () => console.log('[Redis Pub] Connection ended'));
  redisSub.on('end', () => console.log('[Redis Sub] Connection ended'));

  adapterInitialized = true;
}

function normalizeKey(key: string) {
  return key.replace(/^texa:/, '');
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

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
    const serialized = JSON.stringify(value);
    const normalizedKey = normalizeKey(key);

    if (ttlSeconds && ttlSeconds > 0) {
      return redis.set(normalizedKey, serialized, 'EX', ttlSeconds);
    }

    return redis.set(normalizedKey, serialized);
  },

  setNX: async <T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> => {
    const serialized = JSON.stringify(value);
    const normalizedKey = normalizeKey(key);

    const result = ttlSeconds && ttlSeconds > 0
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

    const fresh = await resolver();
    await cache.set(key, fresh, ttlSeconds);
    return fresh;
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

  ttl: async (key: string): Promise<number> => {
    return redis.ttl(normalizeKey(key));
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

  hgetAll: async <T = Record<string, any>>(key: string): Promise<T> => {
    const data = await redis.hgetall(normalizeKey(key));
    const parsed: Record<string, any> = {};

    for (const [field, value] of Object.entries(data)) {
      parsed[field] = safeJsonParse(value);
    }

    return parsed as T;
  },

  hset: async <T>(key: string, field: string, value: T): Promise<number> => {
    return redis.hset(normalizeKey(key), field, JSON.stringify(value));
  },

  hmset: async <T extends Record<string, any>>(key: string, values: T): Promise<'OK'> => {
    const serialized: Record<string, string> = {};

    for (const [field, value] of Object.entries(values)) {
      serialized[field] = JSON.stringify(value);
    }

    return redis.hmset(normalizeKey(key), serialized);
  },

  hdel: async (key: string, fields: string | string[]): Promise<number> => {
    return redis.hdel(normalizeKey(key), ...(Array.isArray(fields) ? fields : [fields]));
  },

  sadd: async <T>(key: string, value: T | T[], ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const values = Array.isArray(value) ? value : [value];
    const result = await redis.sadd(normalizedKey, values.map(v => JSON.stringify(v)));

    if (ttlSeconds && ttlSeconds > 0) {
      await redis.expire(normalizedKey, ttlSeconds);
    }

    return result;
  },

  srem: async <T>(key: string, value: T | T[]): Promise<number> => {
    const values = Array.isArray(value) ? value : [value];
    return redis.srem(normalizeKey(key), values.map(v => JSON.stringify(v)));
  },

  smembers: async <T>(key: string): Promise<T[]> => {
    const data = await redis.smembers(normalizeKey(key));
    return data.map(item => safeJsonParse<T>(item)).filter(Boolean) as T[];
  },

  sismember: async <T>(key: string, value: T): Promise<boolean> => {
    const result = await redis.sismember(normalizeKey(key), JSON.stringify(value));
    return result === 1;
  },

  zadd: async (key: string, score: number, member: string, ttlSeconds?: number): Promise<number> => {
    const normalizedKey = normalizeKey(key);
    const result = await redis.zadd(normalizedKey, score, member);

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

  publish: async <T>(channel: string, payload: T): Promise<number> => {
    return redisPub.publish(`${KEY_PREFIX}${normalizeKey(channel)}`, JSON.stringify(payload));
  },

  subscribe: async <T>(
    channel: string,
    handler: (payload: T, channel: string) => void
  ): Promise<void> => {
    const normalizedChannel = `${KEY_PREFIX}${normalizeKey(channel)}`;

    await redisSub.subscribe(normalizedChannel);

    redisSub.on('message', (receivedChannel, message) => {
      if (receivedChannel !== normalizedChannel) return;
      handler(safeJsonParse<T>(message) as T, receivedChannel);
    });
  },

  lock: async (key: string, ttlSeconds = 10): Promise<string | null> => {
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const result = await redis.set(`lock:${normalizeKey(key)}`, token, 'EX', ttlSeconds, 'NX');
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

    const result = await redis.eval(script, 1, `lock:${normalizeKey(key)}`, token);
    return result === 1;
  },

  rateLimit: async (
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> => {
    const normalizedKey = `rate:${normalizeKey(key)}`;
    const current = await redis.incr(normalizedKey);

    if (current === 1) {
      await redis.expire(normalizedKey, windowSeconds);
    }

    const ttl = await redis.ttl(normalizedKey);

    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetIn: ttl > 0 ? ttl : windowSeconds
    };
  },

  invalidatePattern: async (pattern: string): Promise<number> => {
    const match = `${KEY_PREFIX}${normalizeKey(pattern)}`;
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
      cursor = nextCursor;

      if (keys.length > 0) {
        const normalizedKeys = keys.map(key => key.replace(KEY_PREFIX, ''));
        deleted += await redis.del(normalizedKeys);
      }
    } while (cursor !== '0');

    return deleted;
  },

  flushTexaCache: async (): Promise<number> => {
    return cache.invalidatePattern('*');
  }
};

export async function closeRedisConnections() {
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
