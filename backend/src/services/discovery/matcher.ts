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

type RedisGeoResult = [string, [string, string], string] | [string, string, [string, string]] | any[];

const normalizeInterest = (interest: string) =>
  String(interest || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 80);

const normalizeId = (id: unknown) => String(id || '').trim();

const safeLimit = (limit: number, min = 1, max = 100) => Math.max(min, Math.min(max, Number.isFinite(limit) ? Math.floor(limit) : min));

const uniq = <T>(items: T[]) => [...new Set(items.filter(Boolean))];

const readJson = async <T>(key: string): Promise<T | null> => {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
};

const writeJson = async (key: string, value: unknown, ttlSeconds: number) => {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {}
};

const getBlockedSet = async (userId: string) => {
  const [blocked, blockedBy] = await Promise.all([
    redis.smembers(`user:blocked:${userId}`),
    redis.smembers(`user:blocked_by:${userId}`)
  ]);
  return new Set([...blocked, ...blockedBy].map(normalizeId));
};

const getFollowingSet = async (userId: string) => {
  const following = await redis.smembers(`user:following:${userId}`);
  return new Set(following.map(normalizeId));
};

const getMutedSet = async (userId: string) => {
  const muted = await redis.smembers(`user:muted:${userId}`);
  return new Set(muted.map(normalizeId));
};

const getRecentSeenSet = async (userId: string) => {
  const seen = await redis.zrange(`match:seen:${userId}`, 0, -1);
  return new Set(seen.map(v => normalizeId(String(v).split(':')[0])));
};

const markSeen = async (userId: string, ids: string[]) => {
  if (!ids.length) return;
  const now = Date.now();
  const key = `match:seen:${userId}`;
  const pipeline = redis.pipeline();
  ids.forEach(id => pipeline.zadd(key, now, id));
  pipeline.zremrangebyscore(key, 0, now - 7 * 24 * 60 * 60 * 1000);
  pipeline.expire(key, 7 * 24 * 60 * 60);
  await pipeline.exec();
};

const scoreCandidates = async (
  userId: string,
  candidateIds: string[],
  reasonMap: Map<string, Set<string>>,
  baseScoreMap: Map<string, number>,
  limit: number
): Promise<MatchCandidate[]> => {
  const ids = uniq(candidateIds.map(normalizeId)).filter(id => id && id !== userId);
  if (!ids.length) return [];

  const [blocked, muted, following, seen] = await Promise.all([
    getBlockedSet(userId),
    getMutedSet(userId),
    getFollowingSet(userId),
    getRecentSeenSet(userId)
  ]);

  const filtered = ids.filter(id => !blocked.has(id) && !muted.has(id));

  const pipeline = redis.pipeline();
  filtered.forEach(id => {
    pipeline.scard(`user:interests:${id}`);
    pipeline.get(`user:last_active:${id}`);
    pipeline.get(`user:trust:${id}`);
    pipeline.sismember(`user:private`, id);
  });

  const raw = await pipeline.exec();

  const scored = filtered.map((id, index) => {
    const offset = index * 4;
    const interestCount = Number(raw?.[offset]?.[1] || 0);
    const lastActive = Number(raw?.[offset + 1]?.[1] || 0);
    const trust = Number(raw?.[offset + 2]?.[1] || 0);
    const isPrivate = Number(raw?.[offset + 3]?.[1] || 0) === 1;
    const hoursSinceActive = lastActive ? (Date.now() - lastActive) / 3600000 : 9999;
    const recencyScore = lastActive ? Math.max(0, 20 - Math.min(20, hoursSinceActive / 3)) : 0;
    const trustScore = Math.min(15, Math.max(0, trust / 6.7));
    const interestRichness = Math.min(8, interestCount);
    const followingBoost = following.has(id) ? 18 : 0;
    const seenPenalty = seen.has(id) ? 25 : 0;
    const privatePenalty = isPrivate && !following.has(id) ? 10 : 0;
    const base = baseScoreMap.get(id) || 0;
    const reasons = [...(reasonMap.get(id) || new Set<string>())];

    if (followingBoost) reasons.push('following');
    if (recencyScore > 10) reasons.push('recently_active');
    if (trustScore > 8) reasons.push('trusted_profile');
    if (interestRichness > 4) reasons.push('rich_interests');
    if (seenPenalty) reasons.push('recently_seen_penalty');
    if (privatePenalty) reasons.push('private_profile_penalty');

    return {
      userId: id,
      score: Math.round((base + recencyScore + trustScore + interestRichness + followingBoost - seenPenalty - privatePenalty) * 100) / 100,
      reasons: uniq(reasons)
    };
  })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit(limit));

  await markSeen(userId, scored.map(s => s.userId));

  return scored;
};

export async function indexUserInterest(userId: string, interests: string[]) {
  const normalized = uniq(interests.map(normalizeInterest)).filter(Boolean);
  const previous = await redis.smembers(`user:interests:${userId}`);
  const pipeline = redis.pipeline();

  previous.forEach(i => pipeline.srem(`interest:${i}`, userId));
  pipeline.del(`user:interests:${userId}`);

  normalized.forEach(i => {
    pipeline.sadd(`interest:${i}`, userId);
    pipeline.sadd(`user:interests:${userId}`, i);
  });

  pipeline.set(`user:interests_updated:${userId}`, Date.now().toString(), 'EX', 30 * 24 * 60 * 60);
  await pipeline.exec();

  return normalized;
}

export async function updateUserLocation(userId: string, lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Invalid coordinates');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Coordinates out of range');

  const pipeline = redis.pipeline();
  pipeline.geoadd('geo:nearby', lng, lat, userId);
  pipeline.set(`user:location:${userId}`, JSON.stringify({ lat, lng, updatedAt: Date.now() }), 'EX', 7 * 24 * 60 * 60);
  await pipeline.exec();

  return { userId, lat, lng };
}

export async function removeUserLocation(userId: string) {
  const pipeline = redis.pipeline();
  pipeline.zrem('geo:nearby', userId);
  pipeline.del(`user:location:${userId}`);
  await pipeline.exec();
  return { removed: true };
}

export async function updateUserActivity(userId: string) {
  await redis.set(`user:last_active:${userId}`, Date.now().toString(), 'EX', 30 * 24 * 60 * 60);
  return { updated: true };
}

export async function matchByInterest(userId: string, interests: string[], limit = 10): Promise<MatchCandidate[]> {
  const finalLimit = safeLimit(limit, 1, 50);
  const normalized = uniq(interests.map(normalizeInterest)).filter(Boolean);
  if (!normalized.length) return [];

  const cacheKey = `match:interest:${userId}:${normalized.sort().join('|')}:${finalLimit}`;
  const cached = await readJson<MatchCandidate[]>(cacheKey);
  if (cached) return cached;

  const sampleSize = Math.max(finalLimit * 6, 30);
  const candidateBuckets = await Promise.all(normalized.map(i => redis.srandmember(`interest:${i}`, sampleSize)));

  const reasonMap = new Map<string, Set<string>>();
  const baseScoreMap = new Map<string, number>();
  const candidateIds: string[] = [];

  candidateBuckets.forEach((bucket, index) => {
    const interest = normalized[index];
    bucket.forEach(idRaw => {
      const id = normalizeId(idRaw);
      if (!id || id === userId) return;
      candidateIds.push(id);
      if (!reasonMap.has(id)) reasonMap.set(id, new Set());
      reasonMap.get(id)!.add(`interest:${interest}`);
      baseScoreMap.set(id, (baseScoreMap.get(id) || 0) + 22);
    });
  });

  const scored = await scoreCandidates(userId, candidateIds, reasonMap, baseScoreMap, finalLimit);
  await writeJson(cacheKey, scored, 120);
  return scored;
}

export async function matchNearby(userId: string, lat: number, lng: number, radiusKm = 50): Promise<NearbyCandidate[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Invalid coordinates');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Coordinates out of range');

  const radius = Math.max(1, Math.min(500, Number(radiusKm) || 50));
  const cacheKey = `match:nearby:${userId}:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}`;
  const cached = await readJson<NearbyCandidate[]>(cacheKey);
  if (cached) return cached;

  const results = await redis.georadius('geo:nearby', lng, lat, radius, 'km', 'WITHCOORD', 'WITHDIST', 'ASC', 'COUNT', 80);
  const blocked = await getBlockedSet(userId);
  const muted = await getMutedSet(userId);
  const seen = await getRecentSeenSet(userId);

  const parsed = (results as RedisGeoResult[])
    .map((row: any) => {
      const user = normalizeId(row[0]);
      const distance = Array.isArray(row[1]) ? Number(row[2]) : Number(row[1]);
      const coord = Array.isArray(row[1]) ? row[1] : row[2];
      const longitude = Number(coord?.[0]);
      const latitude = Number(coord?.[1]);
      return { userId: user, distanceKm: distance, longitude, latitude };
    })
    .filter(item => item.userId && item.userId !== userId && !blocked.has(item.userId) && !muted.has(item.userId));

  const pipeline = redis.pipeline();
  parsed.forEach(item => {
    pipeline.sinter(`user:interests:${userId}`, `user:interests:${item.userId}`);
    pipeline.get(`user:last_active:${item.userId}`);
    pipeline.get(`user:trust:${item.userId}`);
  });

  const raw = await pipeline.exec();

  const scored = parsed.map((item, index) => {
    const offset = index * 3;
    const commonInterests = (raw?.[offset]?.[1] as string[]) || [];
    const lastActive = Number(raw?.[offset + 1]?.[1] || 0);
    const trust = Number(raw?.[offset + 2]?.[1] || 0);
    const distanceScore = Math.max(0, 35 - (item.distanceKm / radius) * 35);
    const interestScore = Math.min(30, commonInterests.length * 10);
    const activeScore = lastActive ? Math.max(0, 20 - Math.min(20, (Date.now() - lastActive) / 3600000 / 3)) : 0;
    const trustScore = Math.min(15, Math.max(0, trust / 6.7));
    const seenPenalty = seen.has(item.userId) ? 20 : 0;
    const reasons = [
      'nearby',
      ...commonInterests.map(i => `shared_interest:${i}`),
      activeScore > 10 ? 'recently_active' : '',
      trustScore > 8 ? 'trusted_profile' : '',
      seenPenalty ? 'recently_seen_penalty' : ''
    ].filter(Boolean);

    return {
      ...item,
      score: Math.round((distanceScore + interestScore + activeScore + trustScore - seenPenalty) * 100) / 100,
      reasons: uniq(reasons)
    };
  })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  await markSeen(userId, scored.map(s => s.userId));
  await writeJson(cacheKey, scored, 90);

  return scored;
}

export async function suggestRooms(userId: string, limit = 5): Promise<RoomSuggestion[]> {
  const finalLimit = safeLimit(limit, 1, 50);
  const cacheKey = `rooms:suggest:${userId}:${finalLimit}`;
  const cached = await readJson<RoomSuggestion[]>(cacheKey);
  if (cached) return cached;

  const userInterests = await redis.smembers(`user:interests:${userId}`);
  const normalized = uniq(userInterests.map(normalizeInterest)).filter(Boolean);
  if (!normalized.length) return [];

  const roomBuckets = await Promise.all(normalized.map(i => redis.smembers(`room:interest:${i}`)));
  const roomIds = uniq(roomBuckets.flat().map(normalizeId));
  if (!roomIds.length) return [];

  const pipeline = redis.pipeline();
  roomIds.forEach(roomId => {
    pipeline.scard(`room:members:${roomId}`);
    pipeline.get(`room:activity:${roomId}`);
    pipeline.get(`room:trust:${roomId}`);
    pipeline.sismember(`room:joined:${userId}`, roomId);
    pipeline.smembers(`room:tags:${roomId}`);
  });

  const raw = await pipeline.exec();

  const suggestions = roomIds.map((roomId, index) => {
    const offset = index * 5;
    const members = Number(raw?.[offset]?.[1] || 0);
    const activity = Number(raw?.[offset + 1]?.[1] || 0);
    const trust = Number(raw?.[offset + 2]?.[1] || 0);
    const joined = Number(raw?.[offset + 3]?.[1] || 0) === 1;
    const tags = ((raw?.[offset + 4]?.[1] as string[]) || []).map(normalizeInterest);
    const shared = tags.filter(tag => normalized.includes(tag));
    const memberScore = Math.min(20, Math.log10(Math.max(1, members)) * 10);
    const activityScore = activity ? Math.max(0, 25 - Math.min(25, (Date.now() - activity) / 3600000 / 2)) : 0;
    const interestScore = Math.min(35, shared.length * 12);
    const trustScore = Math.min(15, trust / 6.7);
    const joinedPenalty = joined ? 50 : 0;
    const score = memberScore + activityScore + interestScore + trustScore - joinedPenalty;

    return {
      roomId,
      score: Math.round(score * 100) / 100,
      reasons: uniq([
        ...shared.map(i => `interest:${i}`),
        members > 50 ? 'popular_room' : '',
        activityScore > 10 ? 'active_room' : '',
        trustScore > 8 ? 'trusted_room' : '',
        joined ? 'already_joined_penalty' : ''
      ].filter(Boolean))
    };
  })
    .filter(room => room.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, finalLimit);

  await writeJson(cacheKey, suggestions, 180);
  return suggestions;
}

export async function indexRoomInterest(roomId: string, interests: string[]) {
  const normalized = uniq(interests.map(normalizeInterest)).filter(Boolean);
  const previous = await redis.smembers(`room:tags:${roomId}`);
  const pipeline = redis.pipeline();

  previous.forEach(i => pipeline.srem(`room:interest:${i}`, roomId));
  pipeline.del(`room:tags:${roomId}`);

  normalized.forEach(i => {
    pipeline.sadd(`room:interest:${i}`, roomId);
    pipeline.sadd(`room:tags:${roomId}`, i);
  });

  pipeline.set(`room:activity:${roomId}`, Date.now().toString(), 'EX', 30 * 24 * 60 * 60);
  await pipeline.exec();

  return normalized;
}

export async function markRoomJoined(userId: string, roomId: string) {
  const pipeline = redis.pipeline();
  pipeline.sadd(`room:joined:${userId}`, roomId);
  pipeline.sadd(`room:members:${roomId}`, userId);
  pipeline.set(`room:activity:${roomId}`, Date.now().toString(), 'EX', 30 * 24 * 60 * 60);
  await pipeline.exec();
  return { joined: true };
}

export async function markRoomLeft(userId: string, roomId: string) {
  const pipeline = redis.pipeline();
  pipeline.srem(`room:joined:${userId}`, roomId);
  pipeline.srem(`room:members:${roomId}`, userId);
  pipeline.set(`room:activity:${roomId}`, Date.now().toString(), 'EX', 30 * 24 * 60 * 60);
  await pipeline.exec();
  return { left: true };
}
