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
  scopeId?: string | null;
  unique?: boolean;
}

export interface AnalyticsRangePoint {
  bucket: string;
  value: number;
  unique: number;
}

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const WEEK_SECONDS = 604800;
const MONTH_SECONDS = 2592000;
const MAX_PROPERTY_LENGTH = 1000;
const MAX_EVENT_LENGTH = 80;
const MAX_SCOPE_LENGTH = 120;
const DEFAULT_RANGE_POINTS = 7;
const MAX_RANGE_POINTS = 366;
const ANALYTICS_TIMEFRAMES: AnalyticsTimeframe[] = ['hour', 'day', 'week', 'month'];
const DASHBOARD_METRICS = [
  'app_open',
  'reel_view',
  'reel_like',
  'reel_share',
  'profile_view',
  'store_view',
  'product_view',
  'add_to_cart',
  'checkout_start',
  'purchase',
  'ad_impression',
  'ad_click',
  'story_view',
  'story_reply',
  'follow',
  'search'
];

const now = () => Date.now();

const clampNumber = (value: any, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

const cleanPart = (value: any, fallback = 'unknown') => {
  const cleaned = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SCOPE_LENGTH);

  return cleaned || fallback;
};

const eventKey = (event: string) => {
  const key = cleanPart(event, 'event').slice(0, MAX_EVENT_LENGTH);
  return key || 'event';
};

const dateKey = (timestamp = now()) => new Date(timestamp).toISOString().slice(0, 10);

const hourKey = (timestamp = now()) => {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}:${String(d.getUTCHours()).padStart(2, '0')}`;
};

const weekKey = (timestamp = now()) => {
  const base = new Date(timestamp);
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / DAY_SECONDS / 1000) + 1) / 7);
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
  if (timeframe === 'day') return MONTH_SECONDS * 3;
  if (timeframe === 'week') return MONTH_SECONDS * 6;
  return MONTH_SECONDS * 18;
};

const scopeKey = (scope: AnalyticsScope = 'global', scopeId?: string | null) => `${cleanPart(scope, 'global')}:${cleanPart(scopeId || 'all', 'all')}`;

const counterKey = (
  event: string,
  timeframe: AnalyticsTimeframe,
  timestamp: number,
  scope: AnalyticsScope = 'global',
  scopeId?: string | null
) => `analytics:counter:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}:${scopeKey(scope, scopeId)}`;

const uniqueKey = (
  event: string,
  timeframe: AnalyticsTimeframe,
  timestamp: number,
  scope: AnalyticsScope = 'global',
  scopeId?: string | null
) => `analytics:unique:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}:${scopeKey(scope, scopeId)}`;

const userCounterKey = (userId: string, event: string, timeframe: AnalyticsTimeframe, timestamp: number) =>
  `analytics:user:${cleanPart(userId)}:${eventKey(event)}:${timeframe}:${bucketKey(timeframe, timestamp)}`;

const timelineKey = (scope: AnalyticsScope, scopeId: string | null | undefined, event: string) =>
  `analytics:timeline:${scopeKey(scope, scopeId)}:${eventKey(event)}`;

const propertyCounterKey = (event: string, property: string, timeframe: AnalyticsTimeframe, timestamp: number) =>
  `analytics:property:${eventKey(event)}:${cleanPart(property)}:${timeframe}:${bucketKey(timeframe, timestamp)}`;

const sanitizePrimitive = (value: any) => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.replace(/\0/g, '').trim().slice(0, MAX_PROPERTY_LENGTH);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value).slice(0, MAX_PROPERTY_LENGTH);
  } catch {
    return String(value).slice(0, MAX_PROPERTY_LENGTH);
  }
};

const sanitizeProperties = (properties: Record<string, any> = {}) => {
  const safe: Record<string, any> = {};

  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return safe;

  for (const [key, value] of Object.entries(properties)) {
    const cleanKey = cleanPart(key);
    if (!cleanKey || cleanKey === 'unknown') continue;
    const sanitized = sanitizePrimitive(value);
    if (sanitized !== undefined) safe[cleanKey] = sanitized;
  }

  return safe;
};

const safeActor = (payload: AnalyticsEventPayload, userId: string | null) => {
  return cleanPart(userId || payload.deviceId || payload.sessionId || payload.ip || 'anonymous', 'anonymous');
};

const normalizeTimestamp = (timestamp?: number) => {
  const parsed = Number(timestamp || now());
  if (!Number.isFinite(parsed) || parsed <= 0) return now();
  return parsed;
};

const incrementKey = async (key: string, ttl: number, amount = 1) => {
  const safeAmount = Math.max(1, Math.floor(Number(amount) || 1));
  const value = await redis.incrby(key, safeAmount);
  await redis.expire(key, ttl);
  return Number(value || 0);
};

const addUnique = async (key: string, value: string, ttl: number) => {
  await redis.pfadd(key, cleanPart(value, 'anonymous'));
  await redis.expire(key, ttl);
};

const enqueueAnalyticsSafe = async (payload: Record<string, any>) => {
  try {
    await enqueueAnalytics(payload);
  } catch {
    return null;
  }
};

export async function trackEvent(userId: string, event: string, properties: Record<string, any> = {}) {
  return trackAnalyticsEvent({
    userId,
    event,
    properties,
    scope: 'user',
    scopeId: userId
  });
}

export async function trackAnalyticsEvent(payload: AnalyticsEventPayload) {
  if (!payload || !payload.event || typeof payload.event !== 'string') {
    return {
      success: false,
      error: 'Invalid analytics event'
    };
  }

  const timestamp = normalizeTimestamp(payload.timestamp);
  const event = eventKey(payload.event);
  const userId = payload.userId ? cleanPart(payload.userId) : null;
  const scope = payload.scope || 'global';
  const scopeId = payload.scopeId || null;
  const properties = sanitizeProperties(payload.properties || {});
  const actor = safeActor(payload, userId);

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

  await enqueueAnalyticsSafe(jobPayload);

  const pipe = redis.pipeline();

  for (const timeframe of ANALYTICS_TIMEFRAMES) {
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
  pipe.zadd(tKey, timestamp, `${timestamp}:${actor}:${Math.random().toString(36).slice(2)}`);
  pipe.zremrangebyscore(tKey, 0, timestamp - MONTH_SECONDS * 1000);
  pipe.expire(tKey, MONTH_SECONDS);

  await pipe.exec();

  return {
    success: true,
    event,
    timestamp,
    scope,
    scopeId
  };
}

export async function trackManyEvents(events: AnalyticsEventPayload[]) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const results = [];

  for (const event of events.slice(0, 500)) {
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
    return Number(count || 0);
  }

  const count = await redis.get(key);
  return Number(count || 0);
}

export async function getStatsRange(
  metric: string,
  timeframe: AnalyticsTimeframe = 'day',
  points = DEFAULT_RANGE_POINTS,
  options: RealtimeStatsOptions = {}
): Promise<AnalyticsRangePoint[]> {
  const scope = options.scope || 'global';
  const scopeId = options.scopeId || null;
  const safePoints = clampNumber(points, DEFAULT_RANGE_POINTS, 1, MAX_RANGE_POINTS);
  const result: AnalyticsRangePoint[] = [];
  const base = new Date();

  for (let i = safePoints - 1; i >= 0; i--) {
    const d = new Date(base);

    if (timeframe === 'hour') d.setUTCHours(d.getUTCHours() - i);
    if (timeframe === 'day') d.setUTCDate(d.getUTCDate() - i);
    if (timeframe === 'week') d.setUTCDate(d.getUTCDate() - i * 7);
    if (timeframe === 'month') d.setUTCMonth(d.getUTCMonth() - i);

    const ts = d.getTime();
    const cKey = counterKey(metric, timeframe, ts, scope, scopeId);
    const uKey = uniqueKey(metric, timeframe, ts, scope, scopeId);
    const [value, unique] = await Promise.all([
      redis.get(cKey),
      redis.pfcount(uKey)
    ]);

    result.push({
      bucket: bucketKey(timeframe, ts),
      value: Number(value || 0),
      unique: Number(unique || 0)
    });
  }

  return result;
}

export async function getTopPropertyValues(metric: string, property: string, timeframe: AnalyticsTimeframe = 'day', limit = 10) {
  const safeLimit = clampNumber(limit, 10, 1, 100);
  const key = propertyCounterKey(metric, property, timeframe, now());
  const values = await redis.hgetall(key);

  return Object.entries(values || {})
    .map(([name, count]) => ({
      name,
      count: Number(count || 0)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, safeLimit);
}

export async function getUserEventCount(userId: string, metric: string, timeframe: AnalyticsTimeframe = 'day') {
  const key = userCounterKey(userId, metric, timeframe, now());
  const value = await redis.get(key);
  return Number(value || 0);
}

export async function getEventTimeline(metric: string, scope: AnalyticsScope = 'global', scopeId?: string | null, sinceMs = DAY_SECONDS * 1000) {
  const key = timelineKey(scope, scopeId, metric);
  const safeSince = clampNumber(sinceMs, DAY_SECONDS * 1000, HOUR_SECONDS * 1000, MONTH_SECONDS * 1000);
  const min = now() - safeSince;
  const rows = await redis.zrangebyscore(key, min, '+inf', 'WITHSCORES');
  const timeline: { id: string; timestamp: number }[] = [];

  for (let i = 0; i < rows.length; i += 2) {
    timeline.push({
      id: rows[i],
      timestamp: Number(rows[i + 1])
    });
  }

  return timeline;
}

export async function incrementMetric(metric: string, amount = 1, scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const timestamp = now();
  const safeAmount = Math.max(1, Math.floor(Number(amount) || 1));
  const result: Record<AnalyticsTimeframe, number> = {} as Record<AnalyticsTimeframe, number>;

  for (const timeframe of ANALYTICS_TIMEFRAMES) {
    result[timeframe] = await incrementKey(counterKey(metric, timeframe, timestamp, scope, scopeId), ttlFor(timeframe), safeAmount);
  }

  return result;
}

export async function trackUnique(metric: string, uniqueId: string, scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const timestamp = now();
  const actor = cleanPart(uniqueId, 'anonymous');

  for (const timeframe of ANALYTICS_TIMEFRAMES) {
    await addUnique(uniqueKey(metric, timeframe, timestamp, scope, scopeId), actor, ttlFor(timeframe));
  }

  return {
    success: true,
    metric: eventKey(metric),
    uniqueId: actor,
    scope,
    scopeId: scopeId || null
  };
}

export async function getDashboardStats(scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const stats: Record<string, any> = {};

  for (const metric of DASHBOARD_METRICS) {
    const [today, uniqueToday, week, uniqueWeek, month, uniqueMonth] = await Promise.all([
      getRealtimeStats(metric, 'day', { scope, scopeId }),
      getRealtimeStats(metric, 'day', { scope, scopeId, unique: true }),
      getRealtimeStats(metric, 'week', { scope, scopeId }),
      getRealtimeStats(metric, 'week', { scope, scopeId, unique: true }),
      getRealtimeStats(metric, 'month', { scope, scopeId }),
      getRealtimeStats(metric, 'month', { scope, scopeId, unique: true })
    ]);

    stats[metric] = {
      today,
      uniqueToday,
      week,
      uniqueWeek,
      month,
      uniqueMonth
    };
  }

  return stats;
}

export async function getMetricOverview(metric: string, scope: AnalyticsScope = 'global', scopeId?: string | null) {
  const [today, uniqueToday, week, month, range] = await Promise.all([
    getRealtimeStats(metric, 'day', { scope, scopeId }),
    getRealtimeStats(metric, 'day', { scope, scopeId, unique: true }),
    getRealtimeStats(metric, 'week', { scope, scopeId }),
    getRealtimeStats(metric, 'month', { scope, scopeId }),
    getStatsRange(metric, 'day', 14, { scope, scopeId })
  ]);

  return {
    metric: eventKey(metric),
    scope,
    scopeId: scopeId || null,
    today,
    uniqueToday,
    week,
    month,
    range
  };
}

export async function flushAnalyticsMetric(metric: string, timeframe: AnalyticsTimeframe = 'day') {
  const safeMetric = eventKey(metric);
  const patterns = [
    `analytics:counter:${safeMetric}:${timeframe}:*`,
    `analytics:unique:${safeMetric}:${timeframe}:*`,
    `analytics:user:*:${safeMetric}:${timeframe}:*`,
    `analytics:property:${safeMetric}:*:${timeframe}:*`
  ];

  let deleted = 0;

  for (const pattern of patterns) {
    const stream = redis.scanStream({
      match: pattern,
      count: 100
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (keys: string[]) => {
        if (!Array.isArray(keys) || keys.length === 0) return;
        stream.pause();

        try {
          deleted += keys.length;
          await redis.del(...keys);
          stream.resume();
        } catch (error) {
          stream.destroy(error as Error);
        }
      });

      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  return {
    deleted
  };
}

export async function flushAnalyticsScope(scope: AnalyticsScope, scopeId?: string | null) {
  const safeScope = scopeKey(scope, scopeId);
  const patterns = [
    `analytics:counter:*:*:*:${safeScope}`,
    `analytics:unique:*:*:*:${safeScope}`,
    `analytics:timeline:${safeScope}:*`
  ];

  let deleted = 0;

  for (const pattern of patterns) {
    const stream = redis.scanStream({
      match: pattern,
      count: 100
    });

    await new Promise<void>((resolve, reject) => {
      stream.on('data', async (keys: string[]) => {
        if (!Array.isArray(keys) || keys.length === 0) return;
        stream.pause();

        try {
          deleted += keys.length;
          await redis.del(...keys);
          stream.resume();
        } catch (error) {
          stream.destroy(error as Error);
        }
      });

      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

  return {
    deleted
  };
}
