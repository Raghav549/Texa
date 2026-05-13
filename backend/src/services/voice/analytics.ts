import { prisma } from '../../config/db';
import { redis } from '../../config/redis';

type RoomEventMeta = Record<string, any>;

type RoomBufferedEvent = {
  roomId: string;
  event: string;
  metadata: RoomEventMeta;
  ts: number;
};

type RoomAnalyticsSummary = {
  total: number;
  events: Record<string, number>;
  uniqueUsers: number;
  users: string[];
  firstEventAt: string;
  lastEventAt: string;
  windowMs: number;
  meta: Record<string, any>;
};

const ROOM_ANALYTICS_TTL_SECONDS = 900;
const ROOM_ANALYTICS_WINDOW_MS = 60_000;
const ROOM_ANALYTICS_MAX_BUFFER = 5000;
const ROOM_ANALYTICS_ALLOWED_EVENT = /^[a-zA-Z0-9:_-]{1,80}$/;
const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{6,128}$/;

function assertRoomId(roomId: string) {
  if (!roomId || typeof roomId !== 'string' || !ROOM_ID_REGEX.test(roomId)) {
    throw new Error('Invalid roomId');
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

function compactMeta(meta: RoomEventMeta = {}) {
  const clean: RoomEventMeta = {};
  Object.entries(meta || {}).forEach(([key, value]) => {
    if (!key || key.length > 60) return;
    if (value === undefined || typeof value === 'function') return;
    if (typeof value === 'string') clean[key] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value;
    else clean[key] = JSON.parse(JSON.stringify(value)).toString?.() ? value : null;
  });
  return clean;
}

function buildSummary(roomId: string, events: RoomBufferedEvent[]): RoomAnalyticsSummary {
  const eventCounts: Record<string, number> = {};
  const users = new Set<string>();
  const meta: Record<string, any> = {};
  let firstTs = Number.MAX_SAFE_INTEGER;
  let lastTs = 0;

  for (const item of events) {
    eventCounts[item.event] = (eventCounts[item.event] || 0) + 1;
    firstTs = Math.min(firstTs, item.ts);
    lastTs = Math.max(lastTs, item.ts);

    const userId = item.metadata?.userId || item.metadata?.viewerId || item.metadata?.actorId;
    if (typeof userId === 'string' && userId.length <= 128) users.add(userId);

    Object.entries(item.metadata || {}).forEach(([key, value]) => {
      if (key === 'userId' || key === 'viewerId' || key === 'actorId') return;
      if (!meta[key]) meta[key] = {};
      const normalized = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'complex';
      meta[key][normalized] = (meta[key][normalized] || 0) + 1;
    });
  }

  return {
    total: events.length,
    events: eventCounts,
    uniqueUsers: users.size,
    users: Array.from(users),
    firstEventAt: new Date(firstTs === Number.MAX_SAFE_INTEGER ? Date.now() : firstTs).toISOString(),
    lastEventAt: new Date(lastTs || Date.now()).toISOString(),
    windowMs: Math.max(0, (lastTs || Date.now()) - (firstTs === Number.MAX_SAFE_INTEGER ? Date.now() : firstTs)),
    meta
  };
}

function getWindowStart(ts = Date.now()) {
  return new Date(Math.floor(ts / ROOM_ANALYTICS_WINDOW_MS) * ROOM_ANALYTICS_WINDOW_MS);
}

function getWindowEnd(windowStart: Date) {
  return new Date(windowStart.getTime() + ROOM_ANALYTICS_WINDOW_MS);
}

export async function trackRoomEvent(roomId: string, event: string, meta: RoomEventMeta = {}) {
  assertRoomId(roomId);
  assertEventName(event);

  const key = analyticsBufferKey(roomId);
  const payload: RoomBufferedEvent = {
    roomId,
    event,
    metadata: compactMeta(meta),
    ts: Date.now()
  };

  const pipeline = redis.multi();
  pipeline.rpush(key, JSON.stringify(payload));
  pipeline.ltrim(key, -ROOM_ANALYTICS_MAX_BUFFER, -1);
  pipeline.expire(key, ROOM_ANALYTICS_TTL_SECONDS);
  await pipeline.exec();

  return payload;
}

export async function trackRoomJoin(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  return trackRoomEvent(roomId, 'room:join', { ...meta, userId });
}

export async function trackRoomLeave(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  return trackRoomEvent(roomId, 'room:leave', { ...meta, userId });
}

export async function trackRoomMessage(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  return trackRoomEvent(roomId, 'room:message', { ...meta, userId });
}

export async function trackRoomReaction(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  return trackRoomEvent(roomId, 'room:reaction', { ...meta, userId });
}

export async function trackRoomView(roomId: string, userId: string, meta: RoomEventMeta = {}) {
  return trackRoomEvent(roomId, 'room:view', { ...meta, userId });
}

export async function getRoomAnalyticsBuffer(roomId: string) {
  assertRoomId(roomId);

  const raw = await redis.lrange(analyticsBufferKey(roomId), 0, -1);
  const events = raw
    .map(item => safeJsonParse<RoomBufferedEvent | null>(item, null))
    .filter((item): item is RoomBufferedEvent => !!item && item.roomId === roomId && !!item.event && typeof item.ts === 'number');

  return {
    roomId,
    buffered: events.length,
    summary: events.length ? buildSummary(roomId, events) : null,
    events
  };
}

export async function flushRoomAnalytics(roomId: string) {
  assertRoomId(roomId);

  const key = analyticsBufferKey(roomId);
  const lockKey = analyticsLockKey(roomId);
  const lock = await redis.set(lockKey, '1', 'PX', 15_000, 'NX');

  if (!lock) return { roomId, flushed: false, reason: 'locked', count: 0 };

  try {
    const raw = await redis.lrange(key, 0, -1);
    if (!raw.length) return { roomId, flushed: false, reason: 'empty', count: 0 };

    const events = raw
      .map(item => safeJsonParse<RoomBufferedEvent | null>(item, null))
      .filter((item): item is RoomBufferedEvent => !!item && item.roomId === roomId && !!item.event && typeof item.ts === 'number');

    if (!events.length) {
      await redis.del(key);
      return { roomId, flushed: false, reason: 'invalid_payloads', count: 0 };
    }

    const summary = buildSummary(roomId, events);
    const windowStart = getWindowStart(events[0]?.ts || Date.now());
    const windowEnd = getWindowEnd(windowStart);

    await prisma.roomAnalytics.upsert({
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

    await redis.del(key);

    return {
      roomId,
      flushed: true,
      count: summary.total,
      windowStart,
      windowEnd,
      summary
    };
  } finally {
    await redis.del(lockKey);
  }
}

export async function flushManyRoomAnalytics(roomIds: string[]) {
  const uniqueRoomIds = Array.from(new Set(roomIds.filter(Boolean)));
  const results = [];

  for (const roomId of uniqueRoomIds) {
    try {
      results.push(await flushRoomAnalytics(roomId));
    } catch (error: any) {
      results.push({ roomId, flushed: false, reason: error?.message || 'flush_failed', count: 0 });
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

  const rows = await prisma.roomAnalytics.findMany({
    where: { roomId },
    orderBy: { windowStart: 'desc' },
    take: Math.min(Math.max(Number(limit) || 48, 1), 168)
  });

  const buffer = await getRoomAnalyticsBuffer(roomId);

  return {
    roomId,
    live: buffer.summary,
    history: rows
  };
}

export async function clearRoomAnalyticsBuffer(roomId: string) {
  assertRoomId(roomId);
  await redis.del(analyticsBufferKey(roomId));
  await redis.del(analyticsLockKey(roomId));
  return { roomId, cleared: true };
}
