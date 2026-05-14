import { redis } from '../../config/redis';

export type MatchCandidate = {
  userId: string;
  score: number;
  reasons: string[];
};

export type NearbyCandidate = {
  userId: string;
  distanceKm: number;
  longitude: number;
  latitude: number;
  score: number;
  reasons: string[];
};

export type RoomSuggestion = {
  roomId: string;
  score: number;
  reasons: string[];
};

type RedisGeoResult = any[];

const DAY_SECONDS = 86400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const MONTH_SECONDS = 30 * DAY_SECONDS;
const MAX_NEARBY_RADIUS_KM = 500;
const DEFAULT_NEARBY_RADIUS_KM = 50;
const DEFAULT_INTEREST_LIMIT = 10;
const DEFAULT_ROOM_LIMIT = 5;

const normalizeInterest = (interest: unknown) =>
  String(interest || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 80);

const normalizeId = (id: unknown) => String(id || '').trim();

const safeNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const safeLimit = (limit: unknown, min = 1, max = 100) => {
  const n = Number(limit);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const uniq = <T>(items: T[]) => [...new Set(items.filter(Boolean))];

const compactReasons = (items: string[]) => uniq(items.map(v => String(v || '').trim()).filter(Boolean));

const readJson = async <T>(key: string): Promise<T | null> => {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const writeJson = async (key: string, value: unknown, ttlSeconds: number) => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {}
};

const delPattern = async (pattern: string) => {
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    const keys: string[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        if (Array.isArray(batch) && batch.length) keys.push(...batch);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (keys.length) {
      for (let i = 0; i < keys.length; i += 500) {
        await redis.del(...keys.slice(i, i + 500));
      }
    }

    return keys.length;
  } catch {
    return 0;
  }
};

const getBlockedSet = async (userId: string) => {
  const id = normalizeId(userId);
  const [blocked, blockedBy] = await Promise.all([
    redis.smembers(`user:blocked:${id}`),
    redis.smembers(`user:blocked_by:${id}`)
  ]);

  return new Set([...blocked, ...blockedBy].map(normalizeId).filter(Boolean));
};

const getFollowingSet = async (userId: string) => {
  const following = await redis.smembers(`user:following:${normalizeId(userId)}`);
  return new Set(following.map(normalizeId).filter(Boolean));
};

const getMutedSet = async (userId: string) => {
  const muted = await redis.smembers(`user:muted:${normalizeId(userId)}`);
  return new Set(muted.map(normalizeId).filter(Boolean));
};

const getRecentSeenSet = async (userId: string) => {
  const seen = await redis.zrange(`match:seen:${normalizeId(userId)}`, 0, -1);
  return new Set(seen.map(v => normalizeId(String(v).split(':')[0])).filter(Boolean));
};

const markSeen = async (userId: string, ids: string[]) => {
  const cleanUserId = normalizeId(userId);
  const cleanIds = uniq(ids.map(normalizeId)).filter(id => id && id !== cleanUserId);
  if (!cleanUserId || !cleanIds.length) return;

  const now = Date.now();
  const key = `match:seen:${cleanUserId}`;
  const pipeline = redis.pipeline();

  cleanIds.forEach(id => pipeline.zadd(key, now, id));
  pipeline.zremrangebyscore(key, 0, now - WEEK_SECONDS * 1000);
  pipeline.expire(key, WEEK_SECONDS);

  await pipeline.exec();
};

const invalidateUserMatchCache = async (userId: string) => {
  const id = normalizeId(userId);
  if (!id) return 0;

  const [interest, nearby, room] = await Promise.all([
    delPattern(`match:interest:${id}:*`),
    delPattern(`match:nearby:${id}:*`),
    delPattern(`rooms:suggest:${id}:*`)
  ]);

  return interest + nearby + room;
};

const invalidateRoomSuggestCache = async () => {
  return delPattern('rooms:suggest:*');
};

const parseGeoRow = (row: RedisGeoResult) => {
  const userId = normalizeId(row?.[0]);

  if (Array.isArray(row?.[1]) && typeof row?.[2] !== 'undefined') {
    return {
      userId,
      distanceKm: safeNumber(row[2]),
      longitude: safeNumber(row[1]?.[0]),
      latitude: safeNumber(row[1]?.[1])
    };
  }

  if (typeof row?.[1] !== 'undefined' && Array.isArray(row?.[2])) {
    return {
      userId,
      distanceKm: safeNumber(row[1]),
      longitude: safeNumber(row[2]?.[0]),
      latitude: safeNumber(row[2]?.[1])
    };
  }

  if (Array.isArray(row?.[2]) && typeof row?.[1] === 'string') {
    return {
      userId,
      distanceKm: safeNumber(row[1]),
      longitude: safeNumber(row[2]?.[0]),
      latitude: safeNumber(row[2]?.[1])
    };
  }

  return {
    userId,
    distanceKm: 0,
    longitude: 0,
    latitude: 0
  };
};

const geoSearchNearby = async (lng: number, lat: number, radiusKm: number, count = 80) => {
  try {
    return await (redis as any).geosearch(
      'geo:nearby',
      'FROMLONLAT',
      lng,
      lat,
      'BYRADIUS',
      radiusKm,
      'km',
      'WITHCOORD',
      'WITHDIST',
      'ASC',
      'COUNT',
      count
    );
  } catch {
    return redis.georadius('geo:nearby', lng, lat, radiusKm, 'km', 'WITHCOORD', 'WITHDIST', 'ASC', 'COUNT', count);
  }
};

const scoreCandidates = async (
  userId: string,
  candidateIds: string[],
  reasonMap: Map<string, Set<string>>,
  baseScoreMap: Map<string, number>,
  limit: number
): Promise<MatchCandidate[]> => {
  const cleanUserId = normalizeId(userId);
  const ids = uniq(candidateIds.map(normalizeId)).filter(id => id && id !== cleanUserId);
  if (!cleanUserId || !ids.length) return [];

  const [blocked, muted, following, seen] = await Promise.all([
    getBlockedSet(cleanUserId),
    getMutedSet(cleanUserId),
    getFollowingSet(cleanUserId),
    getRecentSeenSet(cleanUserId)
  ]);

  const filtered = ids.filter(id => !blocked.has(id) && !muted.has(id));
  if (!filtered.length) return [];

  const pipeline = redis.pipeline();

  filtered.forEach(id => {
    pipeline.scard(`user:interests:${id}`);
    pipeline.get(`user:last_active:${id}`);
    pipeline.get(`user:trust:${id}`);
    pipeline.sismember('user:private', id);
    pipeline.sismember(`user:blocked:${id}`, cleanUserId);
    pipeline.sismember(`user:muted:${id}`, cleanUserId);
  });

  const raw = await pipeline.exec();

  const scored = filtered
    .map((id, index) => {
      const offset = index * 6;
      const interestCount = safeNumber(raw?.[offset]?.[1]);
      const lastActive = safeNumber(raw?.[offset + 1]?.[1]);
      const trust = safeNumber(raw?.[offset + 2]?.[1]);
      const isPrivate = safeNumber(raw?.[offset + 3]?.[1]) === 1;
      const blockedMe = safeNumber(raw?.[offset + 4]?.[1]) === 1;
      const mutedMe = safeNumber(raw?.[offset + 5]?.[1]) === 1;

      if (blockedMe || mutedMe) return null;

      const hoursSinceActive = lastActive ? (Date.now() - lastActive) / 3600000 : 9999;
      const recencyScore = lastActive ? Math.max(0, 20 - Math.min(20, hoursSinceActive / 3)) : 0;
      const trustScore = Math.min(15, Math.max(0, trust / 6.7));
      const interestRichness = Math.min(8, interestCount);
      const followingBoost = following.has(id) ? 18 : 0;
      const seenPenalty = seen.has(id) ? 25 : 0;
      const privatePenalty = isPrivate && !following.has(id) ? 10 : 0;
      const base = baseScoreMap.get(id) || 0;
      const score = Math.round((base + recencyScore + trustScore + interestRichness + followingBoost - seenPenalty - privatePenalty) * 100) / 100;

      const reasons = compactReasons([
        ...(reasonMap.get(id) || new Set<string>()),
        followingBoost ? 'following' : '',
        recencyScore > 10 ? 'recently_active' : '',
        trustScore > 8 ? 'trusted_profile' : '',
        interestRichness > 4 ? 'rich_interests' : '',
        seenPenalty ? 'recently_seen_penalty' : '',
        privatePenalty ? 'private_profile_penalty' : ''
      ]);

      return {
        userId: id,
        score,
        reasons
      };
    })
    .filter((item): item is MatchCandidate => Boolean(item && item.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit(limit));

  await markSeen(cleanUserId, scored.map(s => s.userId));

  return scored;
};

export async function indexUserInterest(userId: string, interests: string[]) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const normalized = uniq((Array.isArray(interests) ? interests : []).map(normalizeInterest)).filter(Boolean);
  const previous = await redis.smembers(`user:interests:${cleanUserId}`);
  const pipeline = redis.pipeline();

  previous.forEach(i => pipeline.srem(`interest:${i}`, cleanUserId));
  pipeline.del(`user:interests:${cleanUserId}`);

  normalized.forEach(i => {
    pipeline.sadd(`interest:${i}`, cleanUserId);
    pipeline.sadd(`user:interests:${cleanUserId}`, i);
  });

  pipeline.set(`user:interests_updated:${cleanUserId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return normalized;
}

export async function updateUserLocation(userId: string, lat: number, lng: number) {
  const cleanUserId = normalizeId(userId);
  const latitude = Number(lat);
  const longitude = Number(lng);

  if (!cleanUserId) throw new Error('User ID required');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Invalid coordinates');
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Coordinates out of range');

  const pipeline = redis.pipeline();
  pipeline.geoadd('geo:nearby', longitude, latitude, cleanUserId);
  pipeline.set(`user:location:${cleanUserId}`, JSON.stringify({ lat: latitude, lng: longitude, updatedAt: Date.now() }), 'EX', WEEK_SECONDS);
  pipeline.set(`user:last_active:${cleanUserId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return { userId: cleanUserId, lat: latitude, lng: longitude };
}

export async function removeUserLocation(userId: string) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const pipeline = redis.pipeline();
  pipeline.zrem('geo:nearby', cleanUserId);
  pipeline.del(`user:location:${cleanUserId}`);
  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return { removed: true };
}

export async function updateUserActivity(userId: string) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  await redis.set(`user:last_active:${cleanUserId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  return { updated: true };
}

export async function matchByInterest(userId: string, interests: string[], limit = DEFAULT_INTEREST_LIMIT): Promise<MatchCandidate[]> {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const finalLimit = safeLimit(limit, 1, 50);
  const normalized = uniq((Array.isArray(interests) ? interests : []).map(normalizeInterest)).filter(Boolean);
  if (!normalized.length) return [];

  const cacheKey = `match:interest:${cleanUserId}:${normalized.slice().sort().join('|')}:${finalLimit}`;
  const cached = await readJson<MatchCandidate[]>(cacheKey);
  if (cached) return cached;

  const sampleSize = Math.max(finalLimit * 8, 40);
  const candidateBuckets = await Promise.all(normalized.map(i => redis.srandmember(`interest:${i}`, sampleSize)));

  const reasonMap = new Map<string, Set<string>>();
  const baseScoreMap = new Map<string, number>();
  const candidateIds: string[] = [];

  candidateBuckets.forEach((bucket, index) => {
    const interest = normalized[index];

    (bucket || []).forEach(idRaw => {
      const id = normalizeId(idRaw);
      if (!id || id === cleanUserId) return;

      candidateIds.push(id);

      if (!reasonMap.has(id)) reasonMap.set(id, new Set());
      reasonMap.get(id)!.add(`interest:${interest}`);

      baseScoreMap.set(id, (baseScoreMap.get(id) || 0) + 22);
    });
  });

  const scored = await scoreCandidates(cleanUserId, candidateIds, reasonMap, baseScoreMap, finalLimit);
  await writeJson(cacheKey, scored, 120);

  return scored;
}

export async function matchNearby(userId: string, lat: number, lng: number, radiusKm = DEFAULT_NEARBY_RADIUS_KM): Promise<NearbyCandidate[]> {
  const cleanUserId = normalizeId(userId);
  const latitude = Number(lat);
  const longitude = Number(lng);

  if (!cleanUserId) throw new Error('User ID required');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Invalid coordinates');
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('Coordinates out of range');

  const radius = Math.max(1, Math.min(MAX_NEARBY_RADIUS_KM, safeNumber(radiusKm, DEFAULT_NEARBY_RADIUS_KM)));
  const cacheKey = `match:nearby:${cleanUserId}:${latitude.toFixed(3)}:${longitude.toFixed(3)}:${radius}`;
  const cached = await readJson<NearbyCandidate[]>(cacheKey);
  if (cached) return cached;

  const results = await geoSearchNearby(longitude, latitude, radius, 100);
  const [blocked, muted, seen] = await Promise.all([
    getBlockedSet(cleanUserId),
    getMutedSet(cleanUserId),
    getRecentSeenSet(cleanUserId)
  ]);

  const parsed = (results as RedisGeoResult[])
    .map(parseGeoRow)
    .filter(item => {
      if (!item.userId || item.userId === cleanUserId) return false;
      if (blocked.has(item.userId) || muted.has(item.userId)) return false;
      if (!Number.isFinite(item.distanceKm)) return false;
      if (!Number.isFinite(item.longitude) || !Number.isFinite(item.latitude)) return false;
      return true;
    });

  if (!parsed.length) return [];

  const pipeline = redis.pipeline();

  parsed.forEach(item => {
    pipeline.sinter(`user:interests:${cleanUserId}`, `user:interests:${item.userId}`);
    pipeline.get(`user:last_active:${item.userId}`);
    pipeline.get(`user:trust:${item.userId}`);
    pipeline.sismember(`user:blocked:${item.userId}`, cleanUserId);
    pipeline.sismember(`user:muted:${item.userId}`, cleanUserId);
  });

  const raw = await pipeline.exec();

  const scored = parsed
    .map((item, index) => {
      const offset = index * 5;
      const commonInterests = Array.isArray(raw?.[offset]?.[1]) ? ((raw?.[offset]?.[1] as string[]) || []).map(normalizeInterest).filter(Boolean) : [];
      const lastActive = safeNumber(raw?.[offset + 1]?.[1]);
      const trust = safeNumber(raw?.[offset + 2]?.[1]);
      const blockedMe = safeNumber(raw?.[offset + 3]?.[1]) === 1;
      const mutedMe = safeNumber(raw?.[offset + 4]?.[1]) === 1;

      if (blockedMe || mutedMe) return null;

      const distanceScore = Math.max(0, 35 - (item.distanceKm / radius) * 35);
      const interestScore = Math.min(30, commonInterests.length * 10);
      const activeScore = lastActive ? Math.max(0, 20 - Math.min(20, (Date.now() - lastActive) / 3600000 / 3)) : 0;
      const trustScore = Math.min(15, Math.max(0, trust / 6.7));
      const seenPenalty = seen.has(item.userId) ? 20 : 0;
      const score = Math.round((distanceScore + interestScore + activeScore + trustScore - seenPenalty) * 100) / 100;

      return {
        ...item,
        score,
        reasons: compactReasons([
          'nearby',
          ...commonInterests.map(i => `shared_interest:${i}`),
          activeScore > 10 ? 'recently_active' : '',
          trustScore > 8 ? 'trusted_profile' : '',
          seenPenalty ? 'recently_seen_penalty' : ''
        ])
      };
    })
    .filter((item): item is NearbyCandidate => Boolean(item && item.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  await markSeen(cleanUserId, scored.map(s => s.userId));
  await writeJson(cacheKey, scored, 90);

  return scored;
}

export async function suggestRooms(userId: string, limit = DEFAULT_ROOM_LIMIT): Promise<RoomSuggestion[]> {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const finalLimit = safeLimit(limit, 1, 50);
  const cacheKey = `rooms:suggest:${cleanUserId}:${finalLimit}`;
  const cached = await readJson<RoomSuggestion[]>(cacheKey);
  if (cached) return cached;

  const userInterests = await redis.smembers(`user:interests:${cleanUserId}`);
  const normalized = uniq(userInterests.map(normalizeInterest)).filter(Boolean);
  if (!normalized.length) return [];

  const roomBuckets = await Promise.all(normalized.map(i => redis.smembers(`room:interest:${i}`)));
  const roomIds = uniq(roomBuckets.flat().map(normalizeId)).filter(Boolean);
  if (!roomIds.length) return [];

  const pipeline = redis.pipeline();

  roomIds.forEach(roomId => {
    pipeline.scard(`room:members:${roomId}`);
    pipeline.get(`room:activity:${roomId}`);
    pipeline.get(`room:trust:${roomId}`);
    pipeline.sismember(`room:joined:${cleanUserId}`, roomId);
    pipeline.smembers(`room:tags:${roomId}`);
    pipeline.get(`room:status:${roomId}`);
  });

  const raw = await pipeline.exec();

  const suggestions = roomIds
    .map((roomId, index) => {
      const offset = index * 6;
      const members = safeNumber(raw?.[offset]?.[1]);
      const activity = safeNumber(raw?.[offset + 1]?.[1]);
      const trust = safeNumber(raw?.[offset + 2]?.[1]);
      const joined = safeNumber(raw?.[offset + 3]?.[1]) === 1;
      const tags = Array.isArray(raw?.[offset + 4]?.[1]) ? ((raw?.[offset + 4]?.[1] as string[]) || []).map(normalizeInterest).filter(Boolean) : [];
      const status = String(raw?.[offset + 5]?.[1] || 'active').toLowerCase();

      if (status && status !== 'active' && status !== 'live' && status !== 'open') return null;

      const shared = tags.filter(tag => normalized.includes(tag));
      const memberScore = Math.min(20, Math.log10(Math.max(1, members)) * 10);
      const activityScore = activity ? Math.max(0, 25 - Math.min(25, (Date.now() - activity) / 3600000 / 2)) : 0;
      const interestScore = Math.min(35, shared.length * 12);
      const trustScore = Math.min(15, Math.max(0, trust / 6.7));
      const joinedPenalty = joined ? 50 : 0;
      const score = Math.round((memberScore + activityScore + interestScore + trustScore - joinedPenalty) * 100) / 100;

      return {
        roomId,
        score,
        reasons: compactReasons([
          ...shared.map(i => `interest:${i}`),
          members > 50 ? 'popular_room' : '',
          activityScore > 10 ? 'active_room' : '',
          trustScore > 8 ? 'trusted_room' : '',
          joined ? 'already_joined_penalty' : ''
        ])
      };
    })
    .filter((room): room is RoomSuggestion => Boolean(room && room.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, finalLimit);

  await writeJson(cacheKey, suggestions, 180);

  return suggestions;
}

export async function indexRoomInterest(roomId: string, interests: string[]) {
  const cleanRoomId = normalizeId(roomId);
  if (!cleanRoomId) throw new Error('Room ID required');

  const normalized = uniq((Array.isArray(interests) ? interests : []).map(normalizeInterest)).filter(Boolean);
  const previous = await redis.smembers(`room:tags:${cleanRoomId}`);
  const pipeline = redis.pipeline();

  previous.forEach(i => pipeline.srem(`room:interest:${i}`, cleanRoomId));
  pipeline.del(`room:tags:${cleanRoomId}`);

  normalized.forEach(i => {
    pipeline.sadd(`room:interest:${i}`, cleanRoomId);
    pipeline.sadd(`room:tags:${cleanRoomId}`, i);
  });

  pipeline.set(`room:activity:${cleanRoomId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  pipeline.set(`room:status:${cleanRoomId}`, 'active', 'EX', MONTH_SECONDS);
  await pipeline.exec();
  await invalidateRoomSuggestCache();

  return normalized;
}

export async function markRoomJoined(userId: string, roomId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanRoomId = normalizeId(roomId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanRoomId) throw new Error('Room ID required');

  const pipeline = redis.pipeline();
  pipeline.sadd(`room:joined:${cleanUserId}`, cleanRoomId);
  pipeline.sadd(`room:members:${cleanRoomId}`, cleanUserId);
  pipeline.set(`room:activity:${cleanRoomId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  pipeline.set(`room:status:${cleanRoomId}`, 'active', 'EX', MONTH_SECONDS);
  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return { joined: true };
}

export async function markRoomLeft(userId: string, roomId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanRoomId = normalizeId(roomId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanRoomId) throw new Error('Room ID required');

  const pipeline = redis.pipeline();
  pipeline.srem(`room:joined:${cleanUserId}`, cleanRoomId);
  pipeline.srem(`room:members:${cleanRoomId}`, cleanUserId);
  pipeline.set(`room:activity:${cleanRoomId}`, Date.now().toString(), 'EX', MONTH_SECONDS);
  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return { left: true };
}

export async function markRoomClosed(roomId: string) {
  const cleanRoomId = normalizeId(roomId);
  if (!cleanRoomId) throw new Error('Room ID required');

  const tags = await redis.smembers(`room:tags:${cleanRoomId}`);
  const pipeline = redis.pipeline();

  tags.forEach(tag => pipeline.srem(`room:interest:${tag}`, cleanRoomId));
  pipeline.del(`room:tags:${cleanRoomId}`);
  pipeline.del(`room:members:${cleanRoomId}`);
  pipeline.set(`room:status:${cleanRoomId}`, 'closed', 'EX', WEEK_SECONDS);
  pipeline.set(`room:activity:${cleanRoomId}`, Date.now().toString(), 'EX', WEEK_SECONDS);

  await pipeline.exec();
  await invalidateRoomSuggestCache();

  return { closed: true };
}

export async function indexUserFollowing(userId: string, followingIds: string[]) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const ids = uniq((Array.isArray(followingIds) ? followingIds : []).map(normalizeId)).filter(id => id && id !== cleanUserId);
  const pipeline = redis.pipeline();

  pipeline.del(`user:following:${cleanUserId}`);
  ids.forEach(id => pipeline.sadd(`user:following:${cleanUserId}`, id));
  pipeline.expire(`user:following:${cleanUserId}`, MONTH_SECONDS);

  await pipeline.exec();
  await invalidateUserMatchCache(cleanUserId);

  return ids;
}

export async function addUserFollowing(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');
  if (cleanUserId === cleanTargetId) throw new Error('Cannot follow yourself');

  await redis.sadd(`user:following:${cleanUserId}`, cleanTargetId);
  await redis.expire(`user:following:${cleanUserId}`, MONTH_SECONDS);
  await invalidateUserMatchCache(cleanUserId);

  return { followed: true };
}

export async function removeUserFollowing(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');

  await redis.srem(`user:following:${cleanUserId}`, cleanTargetId);
  await invalidateUserMatchCache(cleanUserId);

  return { unfollowed: true };
}

export async function blockUser(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');
  if (cleanUserId === cleanTargetId) throw new Error('Cannot block yourself');

  const pipeline = redis.pipeline();
  pipeline.sadd(`user:blocked:${cleanUserId}`, cleanTargetId);
  pipeline.sadd(`user:blocked_by:${cleanTargetId}`, cleanUserId);
  pipeline.expire(`user:blocked:${cleanUserId}`, MONTH_SECONDS * 12);
  pipeline.expire(`user:blocked_by:${cleanTargetId}`, MONTH_SECONDS * 12);
  await pipeline.exec();

  await Promise.all([
    invalidateUserMatchCache(cleanUserId),
    invalidateUserMatchCache(cleanTargetId)
  ]);

  return { blocked: true };
}

export async function unblockUser(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');

  const pipeline = redis.pipeline();
  pipeline.srem(`user:blocked:${cleanUserId}`, cleanTargetId);
  pipeline.srem(`user:blocked_by:${cleanTargetId}`, cleanUserId);
  await pipeline.exec();

  await Promise.all([
    invalidateUserMatchCache(cleanUserId),
    invalidateUserMatchCache(cleanTargetId)
  ]);

  return { unblocked: true };
}

export async function muteUser(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');
  if (cleanUserId === cleanTargetId) throw new Error('Cannot mute yourself');

  await redis.sadd(`user:muted:${cleanUserId}`, cleanTargetId);
  await redis.expire(`user:muted:${cleanUserId}`, MONTH_SECONDS * 12);
  await invalidateUserMatchCache(cleanUserId);

  return { muted: true };
}

export async function unmuteUser(userId: string, targetId: string) {
  const cleanUserId = normalizeId(userId);
  const cleanTargetId = normalizeId(targetId);

  if (!cleanUserId) throw new Error('User ID required');
  if (!cleanTargetId) throw new Error('Target ID required');

  await redis.srem(`user:muted:${cleanUserId}`, cleanTargetId);
  await invalidateUserMatchCache(cleanUserId);

  return { unmuted: true };
}

export async function setUserPrivate(userId: string, isPrivate: boolean) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  if (isPrivate) await redis.sadd('user:private', cleanUserId);
  else await redis.srem('user:private', cleanUserId);

  await invalidateUserMatchCache(cleanUserId);

  return { private: Boolean(isPrivate) };
}

export async function setUserTrust(userId: string, trust: number) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const score = Math.max(0, Math.min(100, safeNumber(trust)));
  await redis.set(`user:trust:${cleanUserId}`, String(score), 'EX', MONTH_SECONDS);
  await invalidateUserMatchCache(cleanUserId);

  return { trust: score };
}

export async function setRoomTrust(roomId: string, trust: number) {
  const cleanRoomId = normalizeId(roomId);
  if (!cleanRoomId) throw new Error('Room ID required');

  const score = Math.max(0, Math.min(100, safeNumber(trust)));
  await redis.set(`room:trust:${cleanRoomId}`, String(score), 'EX', MONTH_SECONDS);
  await invalidateRoomSuggestCache();

  return { trust: score };
}

export async function clearUserRecommendationState(userId: string) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error('User ID required');

  const pipeline = redis.pipeline();
  pipeline.del(`match:seen:${cleanUserId}`);
  pipeline.del(`user:last_active:${cleanUserId}`);
  pipeline.del(`user:location:${cleanUserId}`);
  pipeline.zrem('geo:nearby', cleanUserId);
  await pipeline.exec();

  await invalidateUserMatchCache(cleanUserId);

  return { cleared: true };
}
