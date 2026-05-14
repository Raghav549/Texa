import { prisma } from '../../config/db';
import { redis } from '../../config/redis';

export type RoomEventMeta = Record<string, any>;

export type RoomBufferedEvent = {
  id: string;
  roomId: string;
  event: string;
  metadata: RoomEventMeta;
  ts: number;
};

export type RoomAnalyticsSummary = {
  roomId: string;
  total: number;
  events: Record<string, number>;
  uniqueUsers: number;
  users: string[];
  firstEventAt: string;
  lastEventAt: string;
  windowMs: number;
  meta: Record<string, Record<string, number>>;
};

export type RoomAnalyticsFlushResult = {
  roomId: string;
  flushed: boolean;
  reason?: string;
  count: number;
  windows?: number;
  summary?: RoomAnalyticsSummary;
  windowStart?: Date;
  windowEnd?: Date;
};

const ROOM_ANALYTICS_TTL_SECONDS = Number(process.env.ROOM_ANALYTICS_TTL_SECONDS || 900);
const ROOM_ANALYTICS_WINDOW_MS = Number(process.env.ROOM_ANALYTICS_WINDOW_MS || 60_000);
const ROOM_ANALYTICS_MAX_BUFFER = Number(process.env.ROOM_ANALYTICS_MAX_BUFFER || 5000);
const ROOM_ANALYTICS_ALLOWED_EVENT = /^[a-zA-Z0-9:_-]{1,80}$/;
const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;
const USER_ID_REGEX = /^[a-zA-Z0-9_-]{3,160}$/;

const now = () => Date.now();

const safeLimit = (value: number, min = 1, max = 168) => {
  const num = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(num) ? Math.floor(num) : min));
};

const eventId = (roomId: string, event: string, ts: number) => `${roomId}:${event}:${ts}:${Math.random().toString(36).slice(2, 10)}`;

function assertRoomId(roomId: string) {
  if (!roomId || typeof roomId !== 'string' || !ROOM_ID_REGEX.test(roomId)) {
    throw new Error('Invalid roomId');
  }
}

function assertUserId(userId: string) {
  if (!userId || typeof userId !== 'string' || !USER_ID_REGEX.test(userId)) {
    throw new Error('Invalid userId');
  }
}

function assertEventName(event: string) {
  if (!event || typeof event !== 'string' || !ROOM_ANALYTICS_ALLOWED_EVENT.test(event)) {
    throw new Error('Invalid analytics event');
  }
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function analyticsBufferKey(roomId: string) {
  return `room:${roomId}:analytics:buffer`;
}

function analyticsLockKey(roomId: string) {
  return `room:${roomId}:analytics:flush_lock`;
}

function compactValue(value: any): any {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(compactValue).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    const clean: RoomEventMeta = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 25)) {
      if (!key || key.length > 60) continue;
      const finalValue = compactValue(nestedValue);
      if (finalValue !== undefined) clean[key] = finalValue;
    }
    return clean;
  }
  return String(value).slice(0, 500);
}

function compactMeta(meta: RoomEventMeta = {}) {
  const clean: RoomEventMeta = {};
  for (const [key, value] of Object.entries(meta || {}).slice(0, 40)) {
    if (!key || key.length > 60) continue;
    const finalValue = compactValue(value);
    if (finalValue !== undefined) clean[key] = finalValue;
  }
  return clean;
}

function normalizeUserFromMeta(meta: RoomEventMeta) {
  const userId = meta?.userId || meta?.viewerId || meta?.actorId || meta?.speakerId || meta?.listenerId;
  return typeof userId === 'string' && userId.length <= 160 ? userId : null;
}

function buildSummary(roomId: string, events: RoomBufferedEvent[]): RoomAnalyticsSummary {
  const eventCounts: Record<string, number> = {};
  const users = new Set<string>();
  const meta: Record<string, Record<string, number>> = {};
  let firstTs = Number.MAX_SAFE_INTEGER;
  let lastTs = 0;

  for (const item of events) {
    eventCounts[item.event] = (eventCounts[item.event] || 0) + 1;
    firstTs = Math.min(firstTs, item.ts);
    lastTs = Math.max(lastTs, item.ts);

    const userId = normalizeUserFromMeta(item.metadata);
    if (userId) users.add(userId);

    for (const [key, value] of Object.entries(item.metadata || {})) {
      if (['userId', 'viewerId', 'actorId', 'speakerId', 'listenerId'].includes(key)) continue;
      if (!meta[key]) meta[key] = {};
      const normalized =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value).slice(0, 120)
          : Array.isArray(value)
            ? 'array'
            : value === null
              ? 'null'
              : 'object';
      meta[key][normalized] = (meta[key][normalized] || 0) + 1;
    }
  }

  const first = firstTs === Number.MAX_SAFE_INTEGER ? now() : firstTs;
  const last = lastTs || now();

  return {
    roomId,
    total: events.length,
    events: eventCounts,
    uniqueUsers: users.size,
    users: Array.from(users).slice(0, 1000),
    firstEventAt: new Date(first).toISOString(),
    lastEventAt: new Date(last).toISOString(),
    windowMs: Math.max(0, last - first),
    meta
  };
}

function getWindowStart(ts = now()) {
  return new Date(Math.floor(ts / ROOM_ANALYTICS_WINDOW_MS) * ROOM_ANALYTICS_WINDOW_MS);
}

function getWindowEnd(windowStart: Date) {
  return new Date(windowStart.getTime() + ROOM_ANALYTICS_WINDOW_MS);
}

function groupEventsByWindow(events: RoomBufferedEvent[]) {
  const grouped = new Map<number, RoomBufferedEvent[]>();

  for (const event of events) {
    const windowStart = getWindowStart(event.ts).getTime();
    if (!grouped.has(windowStart)) grouped.set(windowStart, []);
    grouped.get(windowStart)!.push(event);
  }

  return grouped;
}

async function hasRoomAnalyticsModel(txOrPrisma: any) {
  return Boolean(txOrPrisma?.roomAnalytics);
}

async function persistWindow(roomId: string, windowStartMs: number, events: RoomBufferedEvent[]) {
  const summary = buildSummary(roomId, events);
  const windowStart = new Date(windowStartMs);
  const windowEnd = getWindowEnd(windowStart);

  if (!(await hasRoomAnalyticsModel(prisma as any))) {
    return {
      windowStart,
      windowEnd,
      summary,
      persisted: false
    };
  }

  await (prisma as any).roomAnalytics.upsert({
    where: {
      roomId_windowStart: {
        roomId,
        windowStart
      }
    },
    update: {
      count: { increment: summary.total },
      event: summary.events,
      metadata: summary,
      windowEnd,
      updatedAt: new Date()
    },
    create: {
      roomId,
      event: summary.events,
      count: summary.total,
      metadata: summary,
      windowStart,
      windowEnd
    }
  });

  return {
    windowStart,
    windowEnd,
    summary,
    persisted: true
  };
}

export async function trackRoomEvent(roomId: string, event: string, meta: RoomEventMeta = {}) {
  assertRoomId(roomId);
  assertEventName(event);

  const ts = now();
  const key = analyticsBufferKey(roomId);
  const payload: RoomBufferedEvent = {
    id: eventId(roomId, event, ts),
    roomId,
    event,
    metadata: compactMeta(meta),
    ts
  };

  const pipeline = redis.multi();
  pipeline.rpush(key, JSON.stringify(payload));
  pipeline.ltrim(key, -ROOM_ANALYTICS_MAX_BUFFER, -1);
  pipeline.expire(key, ROOM_ANALYTICS_TTL_SECONDS);
  await pipeline.exec();

  return payload;
}

export async function trackRoomJoin(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:join', { ...meta, userId });
}

export async function trackRoomLeave(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:leave', { ...meta, userId });
}

export async function trackRoomMessage(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:message', { ...meta, userId });
}

export async function trackRoomReaction(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:reaction', { ...meta, userId });
}

export async function trackRoomView(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:view', { ...meta, userId });
}

export async function trackRoomSpeaking(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:speaking', { ...meta, userId });
}

export async function trackRoomGift(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:gift', { ...meta, userId });
}

export async function trackRoomSeatChange(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  assertUserId(userId);
  return trackRoomEvent(roomId, 'room:seat_change', { ...meta, userId });
}

export async function getRoomAnalyticsBuffer(roomId: string) {
  assertRoomId(roomId);

  const raw = await redis.lrange(analyticsBufferKey(roomId), 0, -1);
  const events = raw
    .map((item) => safeJsonParse<RoomBufferedEvent | null>(item, null))
    .filter((item): item is RoomBufferedEvent => {
      return Boolean(item && item.roomId === roomId && item.event && typeof item.ts === 'number');
    });

  return {
    roomId,
    buffered: events.length,
    summary: events.length ? buildSummary(roomId, events) : null,
    events
  };
}

export async function flushRoomAnalytics(roomId: string): Promise<RoomAnalyticsFlushResult> {
  assertRoomId(roomId);

  const key = analyticsBufferKey(roomId);
  const lockKey = analyticsLockKey(roomId);
  const lock = await redis.set(lockKey, String(now()), 'PX', 15_000, 'NX');

  if (!lock) return { roomId, flushed: false, reason: 'locked', count: 0 };

  try {
    const raw = await redis.lrange(key, 0, -1);

    if (!raw.length) {
      return { roomId, flushed: false, reason: 'empty', count: 0 };
    }

    const events = raw
      .map((item) => safeJsonParse<RoomBufferedEvent | null>(item, null))
      .filter((item): item is RoomBufferedEvent => {
        return Boolean(item && item.roomId === roomId && item.event && typeof item.ts === 'number');
      });

    if (!events.length) {
      await redis.del(key);
      return { roomId, flushed: false, reason: 'invalid_payloads', count: 0 };
    }

    const grouped = groupEventsByWindow(events);
    const persisted = [];

    for (const [windowStartMs, windowEvents] of grouped.entries()) {
      persisted.push(await persistWindow(roomId, windowStartMs, windowEvents));
    }

    await redis.del(key);

    const summary = buildSummary(roomId, events);
    const firstWindow = persisted[0];

    return {
      roomId,
      flushed: true,
      count: summary.total,
      windows: persisted.length,
      windowStart: firstWindow?.windowStart,
      windowEnd: firstWindow?.windowEnd,
      summary
    };
  } finally {
    await redis.del(lockKey);
  }
}

export async function flushManyRoomAnalytics(roomIds: string[]) {
  const uniqueRoomIds = Array.from(new Set(roomIds.map((id) => String(id || '').trim()).filter(Boolean)));
  const results: RoomAnalyticsFlushResult[] = [];

  for (const roomId of uniqueRoomIds) {
    try {
      results.push(await flushRoomAnalytics(roomId));
    } catch (error: any) {
      results.push({
        roomId,
        flushed: false,
        reason: error?.message || 'flush_failed',
        count: 0
      });
    }
  }

  return results;
}

export async function flushAllBufferedRoomAnalytics() {
  const stream = redis.scanStream({
    match: 'room:*:analytics:buffer',
    count: 100
  });

  const roomIds = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      for (const key of keys) {
        const match = key.match(/^room:(.+):analytics:buffer$/);
        if (match?.[1]) roomIds.add(match[1]);
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return flushManyRoomAnalytics(Array.from(roomIds));
}

export async function getRoomAnalytics(roomId: string, limit = 48) {
  assertRoomId(roomId);

  const take = safeLimit(limit);
  const buffer = await getRoomAnalyticsBuffer(roomId);

  if (!(await hasRoomAnalyticsModel(prisma as any))) {
    return {
      roomId,
      live: buffer.summary,
      history: []
    };
  }

  const history = await (prisma as any).roomAnalytics.findMany({
    where: { roomId },
    orderBy: { windowStart: 'desc' },
    take
  });

  return {
    roomId,
    live: buffer.summary,
    history
  };
}

export async function getRoomAnalyticsSummary(roomId: string, limit = 48) {
  const analytics = await getRoomAnalytics(roomId, limit);
  const history = Array.isArray(analytics.history) ? analytics.history : [];

  const events: Record<string, number> = {};
  let total = 0;

  for (const row of history) {
    total += Number(row.count || 0);
    const rowEvents = row.event || row.events || {};
    for (const [event, count] of Object.entries(rowEvents)) {
      events[event] = (events[event] || 0) + Number(count || 0);
    }
  }

  if (analytics.live?.events) {
    total += analytics.live.total;
    for (const [event, count] of Object.entries(analytics.live.events)) {
      events[event] = (events[event] || 0) + Number(count || 0);
    }
  }

  return {
    roomId,
    total,
    events,
    live: analytics.live,
    windows: history.length,
    history
  };
}

export async function clearRoomAnalyticsBuffer(roomId: string) {
  assertRoomId(roomId);
  await redis.del(analyticsBufferKey(roomId));
  await redis.del(analyticsLockKey(roomId));
  return { roomId, cleared: true };
}

export async function deleteRoomAnalytics(roomId: string) {
  assertRoomId(roomId);

  await clearRoomAnalyticsBuffer(roomId);

  if (!(await hasRoomAnalyticsModel(prisma as any))) {
    return { roomId, deleted: 0 };
  }

  const result = await (prisma as any).roomAnalytics.deleteMany({
    where: { roomId }
  });

  return {
    roomId,
    deleted: result.count || 0
  };
}
