import { redis } from '../../config/redis';
import { enqueueAnalytics } from '../../workers';

export type AnalyticsTimeframe = 'hour' | 'day' | 'week' | 'month';
export type AnalyticsScope = 'global' | 'user' | 'store' | 'product' | 'reel' | 'story' | 'ad';

export interface AnalyticsEventPayload {
  userId?: string | null;
  event: string;
  scope?: AnalyticsScope;
  scopeId?: string | null;
  properties?: Record<string, any>;
  timestamp?: number;
  sessionId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RealtimeStatsOptions {
  scope?: AnalyticsScope;
  scopeId?: string;
  unique?: boolean;
}

const WEEK_SECONDS = 604800;
const MONTH_SECONDS = 2592000;
const MAX_PROPERTY_LENGTH = 1000;
const MAX_EVENT_LENGTH = 80;

const cleanPart = (value: any) => String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '_').slice(0, 120) || 'unknown';

const now = () => Date.now();

const dateKey = (timestamp = now()) => new Date(timestamp).toISOString().slice(0, 10);

const hourKey = (timestamp = now()) => {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}:${String(d.getUTCHours()).padStart(2, '0')}`;
};

const weekKey = (timestamp = now()) => {
  const d = new Date(Date.UTC(new Date(timestamp).getUTCFullYear(), new Date(timestamp).getUTCMonth(), new Date(timestamp).getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-w${String(week).padStart(2, '0')}`;
};

const monthKey = (timestamp = now()) => {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const bucketKey = (timeframe: AnalyticsTimeframe, timestamp = now()) => {
  if (timeframe === 'hour') return hourKey(timestamp);
  if (timeframe === 'week') return weekKey(timestamp);
  if (timeframe === 'month') return monthKey(timestamp);
  return dateKey(timestamp);
};

const ttlFor = (timeframe: AnalyticsTimeframe) => {
  if (timeframe === 'hour') return WEEK_SECONDS;
  if (timeframe === 'month') return MONTH_SECONDS * 6;
  return MONTH_SECONDS * 3;
};

const sanitizeProperties = (properties: Record<string, any> = {}) => {
  const safe: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties || {})) {
    const cleanKey = cleanPart(key);
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      safe[cleanKey] = value;
      continue;
    }
    if (typeof value === 'string') {
      safe[cleanKey] = value.slice(0, MAX_PROPERTY_LENGTH);
      continue;
    }
    try {
      safe[cleanKey] = JSON.stringify(value).slice(0, MAX_PROPERTY_LENGTH);
    } catch {
      safe[cleanKey] = String(value).slice(0, MAX_PROPERTY_LENGTH);
    }
  }
  return safe;
};

const eventKey = (event: string) => cleanPart(event).slice(0, MAX_EVENT_LENGTH);

const scopeKey = (scope: AnalyticsScope = 'global', scopeId?: string | null) => `${cleanPart(scope)}:${cleanPart(scopeId || 'all')}`;

const counterKey = (event: string, timeframe: AnalyticsTimeframe, timestamp: number, scope: AnalyticsScope = 'global', scopeId?: string | null) => `analytics:counter:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}:${scopeKey(scope, scopeId)}`;

const uniqueKey = (event: string, timeframe: AnalyticsTimeframe, timestamp: number, scope: AnalyticsScope = 'global', scopeId?: string | null) => `analytics:unique:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}:${scopeKey(scope, scopeId)}`;

const userCounterKey = (userId: string, event: string, timeframe: AnalyticsTimeframe, timestamp: number) => `analytics:user:${cleanPart(userId)}:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}`;

const timelineKey = (scope: AnalyticsScope, scopeId: string | null | undefined, event: string) => `analytics:timeline:${scopeKey(scope, scopeId)}:${eventKey(event)}`;

const propertyCounterKey = (event: string, property: string, timeframe: AnalyticsTimeframe, timestamp: number) => `analytics:property:${eventKey(event)}:${cleanPart(property)}:${timeframe}:${bucketKey(timeframe, timestamp)}`;

const incrementKey = async (key: string, ttl: number, amount = 1) => {
  const value = await redis.incrby(key, amount);
  await redis.expire(key, ttl);
  return value;
};

const addUnique = async (key: string, value: string, ttl: number) => {
  await redis.pfadd(key, value);
  await redis.expire(key, ttl);
};

const pushTimeline = async (key: string, timestamp: number, value: number) => {
  await redis.zadd(key, timestamp, `${timestamp}:${value}`);
  await redis.zremrangebyscore(key, 0, timestamp - MONTH_SECONDS * 1000);
  await redis.expire(key, MONTH_SECONDS);
};

export async function trackEvent(userId: string, event: string, properties: Record<string, any> = {}) {
  return trackAnalyticsEvent({ userId, event, properties });
}

export async function trackAnalyticsEvent(payload: AnalyticsEventPayload) {
  const timestamp = Number(payload.timestamp || now());
  const event = eventKey(payload.event);
  const userId = payload.userId ? cleanPart(payload.userId) : null;
  const scope = payload.scope || 'global';
  const scopeId = payload.scopeId || null;
  const properties = sanitizeProperties(payload.properties || {});
  const actor = userId || payload.deviceId || payload.sessionId || payload.ip || 'anonymous';

  const jobPayload = {
    userId,
    event,
    scope,
    scopeId,
    properties,
    timestamp,
    sessionId: payload.sessionId || null,
    deviceId: payload.deviceId || null,
    ip: payload.ip || null,
    userAgent: payload.userAgent || null
  };

  await enqueueAnalytics(jobPayload);

  const pipe = redis.pipeline();

  for (const timeframe of ['hour', 'day', 'week', 'month'] as AnalyticsTimeframe[]) {
    const ttl = ttlFor(timeframe);
    const cKey = counterKey(event, timeframe, timestamp, scope, scopeId);
    const gKey = counterKey(event, timeframe, timestamp, 'global', null);
    const uKey = uniqueKey(event, timeframe, timestamp, scope, scopeId);
    const guKey = uniqueKey(event, timeframe, timestamp, 'global', null);

    pipe.incrby(cKey, 1);
    pipe.expire(cKey, ttl);
    pipe.incrby(gKey, 1);
    pipe.expire(gKey, ttl);
    pipe.pfadd(uKey, actor);
    pipe.expire(uKey, ttl);
    pipe.pfadd(guKey, actor);
    pipe.expire(guKey, ttl);

    if (userId) {
      const ucKey = userCounterKey(userId, event, timeframe, timestamp);
      pipe.incrby(ucKey, 1);
      pipe.expire(ucKey, ttl);
    }

    for (const [property, value] of Object.entries(properties)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const pKey = propertyCounterKey(event, property, timeframe, timestamp);
        pipe.hincrby(pKey, cleanPart(value), 1);
        pipe.expire(pKey, ttl);
      }
    }
  }

  const tKey = timelineKey(scope, scopeId, event);
  pipe.zadd(tKey, timestamp, `${timestamp}:${Math.random().toString(36).slice(2)}`);
  pipe.expire(tKey, MONTH_SECONDS);

  await pipe.exec();

  return { success: true, event, timestamp, scope, scopeId };
}

export async function trackManyEvents(events: AnalyticsEventPayload[]) {
  const results = [];
  for (const event of events) {
    results.push(await trackAnalyticsEvent(event));
  }
  return results;
}

export async function getRealtimeStats(metric: string, timeframe: AnalyticsTimeframe = 'day', options: RealtimeStatsOptions = {}) {
  const timestamp = now();
  const scope = options.scope || 'global';
  const scopeId = options.scopeId || null;
  const key = options.unique
    ? uniqueKey(metric, timeframe, timestamp, scope, scopeId)
    : counterKey(metric, timeframe, timestamp, scope, scopeId);

  if (options.unique) {
    const count = await redis.pfcount(key);
    return count || 0;
  }

  const count = await redis.get(key);
  return Number(count || 0);
}

export async function getStatsRange(metric: string, timeframe: AnalyticsTimeframe = 'day', points = 7, options: RealtimeStatsOptions = {}) {
  const scope = options.scope || 'global';
  const scopeId = options.scopeId || null;
  const result: { bucket: string; value: number; unique?: number }[] = [];
  const base = new Date();

  for (let i = points - 1; i >= 0; i--) {
    const d = new Date(base);
    if (timeframe === 'hour') d.setUTCHours(d.getUTCHours() - i);
    if (timeframe === 'day') d.setUTCDate(d.getUTCDate() - i);
    if (timeframe === 'week') d.setUTCDate(d.getUTCDate() - i * 7);
    if (timeframe === 'month') d.setUTCMonth(d.getUTCMonth() - i);

    const ts = d.getTime();
    const cKey = counterKey(metric, timeframe, ts, scope, scopeId);
    const uKey = uniqueKey(metric, timeframe, ts, scope, scopeId);
    const [value, unique] = await Promise.all([redis.get(cKey), redis.pfcount(uKey)]);

    result.push({
      bucket: bucketKey(timeframe, ts),
      value: Number(value || 0),
      unique: Number(unique || 0)
    });
  }

  return result;
}

export async function getTopPropertyValues(metric: string, property: string, timeframe: AnalyticsTimeframe = 'day', limit = 10) {
  const key = propertyCounterKey(metric, property, timeframe, now());
  const values = await redis.hgetall(key);
  return Object.entries(values)
    .map(([name, count]) => ({ name, count: Number(count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export async function getUserEventCount(userId: string, metric: string, timeframe: AnalyticsTimeframe = 'day') {
  const key = userCounterKey(userId, metric, timeframe, now());
  const value = await redis.get(key);
  return Number(value || 0);
}

export async function getEventTimeline(metric: string, scope: AnalyticsScope = 'global', scopeId?: string | null, sinceMs = 86400000) {
  const key = timelineKey(scope, scopeId, metric);
  const min = now() - sinceMs;
  const rows = await redis.zrangebyscore(key, min, '+inf', 'WITHSCORES');
  const timeline: { id: string; timestamp: number }[] = [];

  for (let i = 0; i < rows.length; i += 2) {
    timeline.push({ id: rows[i], timestamp: Number(rows[i + 1]) });
  }

  return timeline;
}

export async function incrementMetric(metric: string, amount = 1, scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const timestamp = now();
  const result: Record<AnalyticsTimeframe, number> = {} as Record<AnalyticsTimeframe, number>;

  for (const timeframe of ['hour', 'day', 'week', 'month'] as AnalyticsTimeframe[]) {
    result[timeframe] = await incrementKey(counterKey(metric, timeframe, timestamp, scope, scopeId), ttlFor(timeframe), amount);
  }

  return result;
}

export async function trackUnique(metric: string, uniqueId: string, scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const timestamp = now();

  for (const timeframe of ['hour', 'day', 'week', 'month'] as AnalyticsTimeframe[]) {
    await addUnique(uniqueKey(metric, timeframe, timestamp, scope, scopeId), uniqueId, ttlFor(timeframe));
  }

  return { success: true };
}

export async function getDashboardStats(scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const metrics = ['app_open', 'reel_view', 'reel_like', 'reel_share', 'profile_view', 'store_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase', 'ad_impression', 'ad_click'];
  const stats: Record<string, any> = {};

  for (const metric of metrics) {
    stats[metric] = {
      today: await getRealtimeStats(metric, 'day', { scope, scopeId }),
      uniqueToday: await getRealtimeStats(metric, 'day', { scope, scopeId, unique: true }),
      week: await getRealtimeStats(metric, 'week', { scope, scopeId }),
      month: await getRealtimeStats(metric, 'month', { scope, scopeId })
    };
  }

  return stats;
}

export async function flushAnalyticsMetric(metric: string, timeframe: AnalyticsTimeframe = 'day') {
  const pattern = `analytics:*:${eventKey(metric)}:${timeframe}:*`;
  const stream = redis.scanStream({ match: pattern, count: 100 });
  const deleted: string[] = [];

  await new Promise<void>((resolve, reject) => {
    stream.on('data', async (keys: string[]) => {
      if (!keys.length) return;
      deleted.push(...keys);
      await redis.del(...keys);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return { deleted: deleted.length };
}
