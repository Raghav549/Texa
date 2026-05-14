import { prisma } from '../config/db';
import { cache } from '../config/redis';

export type AdEventType = 'impression' | 'click' | 'conversion';

export type AdContext = {
  screen?: string;
  storeId?: string;
  categoryId?: string;
  productId?: string;
  placement?: string;
  limit?: number;
  excludeAdIds?: string[];
  sessionId?: string;
  device?: string;
  country?: string;
  region?: string;
  city?: string;
  metadata?: Record<string, any>;
};

export type UserAdProfile = {
  interests: string[];
  location: any;
  purchaseHistory: any[];
  recentlyViewedCategories: string[];
  recentlyViewedProducts: string[];
  blockedStores: string[];
  age?: number | null;
  language?: string | null;
};

export type CreateAdvertisementInput = {
  storeId?: string | null;
  advertiserId?: string | null;
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  targetUrl?: string | null;
  productId?: string | null;
  categoryId?: string | null;
  placement?: string | null;
  screen?: string | null;
  pricingModel?: string | null;
  bidAmount?: number | null;
  budget?: number | null;
  priority?: number | null;
  targetAudience?: Record<string, any> | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  status?: string | null;
};

export type UpdateAdvertisementInput = Partial<CreateAdvertisementInput> & {
  status?: string | null;
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const IMPRESSION_WEIGHT = 1;
const CLICK_WEIGHT = 8;
const CONVERSION_WEIGHT = 35;
const MIN_QUALITY_SCORE = 0;
const MAX_QUALITY_SCORE = 100;
const ACTIVE_STATUS = 'active';
const CACHE_TTL = 20;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value: any) {
  return String(value || '').trim().toLowerCase();
}

function cleanString(value: any, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanNullableString(value: any, max = 500) {
  const text = cleanString(value, max);
  return text || null;
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeDate(value: any, fallback: Date) {
  const date = value ? new Date(value) : fallback;
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function parseLocation(location: any) {
  if (!location) return {};
  if (typeof location === 'string') return { raw: normalizeText(location) };
  return {
    country: normalizeText(location.country),
    region: normalizeText(location.region || location.state),
    city: normalizeText(location.city),
    raw: normalizeText(location.raw || location.address || location.name)
  };
}

function matchesAny(source: string[], target: string[]) {
  const set = new Set(source.map(normalizeText).filter(Boolean));
  return target.map(normalizeText).filter(Boolean).filter(item => set.has(item));
}

function calculateCTR(ad: any) {
  const impressions = safeNumber(ad.impressions);
  const clicks = safeNumber(ad.clicks);
  if (impressions <= 0) return 0;
  return clicks / impressions;
}

function calculateCVR(ad: any) {
  const clicks = safeNumber(ad.clicks);
  const conversions = safeNumber(ad.conversions);
  if (clicks <= 0) return 0;
  return conversions / clicks;
}

function getBidAmount(ad: any) {
  return safeNumber(ad.bidAmount ?? ad.cpm ?? ad.cpc ?? ad.cpa, 0);
}

function calculateSpend(ad: any) {
  const pricingModel = normalizeText(ad.pricingModel || ad.billingModel || 'cpm');
  const bidAmount = getBidAmount(ad);
  const impressions = safeNumber(ad.impressions);
  const clicks = safeNumber(ad.clicks);
  const conversions = safeNumber(ad.conversions);
  if (pricingModel === 'cpc') return clicks * bidAmount;
  if (pricingModel === 'cpa') return conversions * bidAmount;
  return (impressions / 1000) * bidAmount;
}

function hasBudget(ad: any) {
  const budget = safeNumber(ad.budget);
  if (budget <= 0) return true;
  return calculateSpend(ad) < budget;
}

function isWithinFrequencyCap(ad: any, frequency: any) {
  const target = ad.targetAudience as any;
  const cap = safeNumber(target?.frequencyCap ?? ad.frequencyCap, 0);
  if (cap <= 0) return true;
  return safeNumber(frequency?.impressions) < cap;
}

function getActiveWindowFilter(now: Date) {
  return {
    status: ACTIVE_STATUS,
    startDate: { lte: now },
    endDate: { gt: now }
  };
}

function getUserLocationScore(userLocation: any, targetLocation: any, context: AdContext) {
  if (!targetLocation) return 0;

  const userLoc = parseLocation(userLocation);
  const targetLoc = parseLocation(targetLocation);
  const ctxCountry = normalizeText(context.country);
  const ctxRegion = normalizeText(context.region);
  const ctxCity = normalizeText(context.city);

  let score = 0;

  if (targetLoc.country && (targetLoc.country === userLoc.country || targetLoc.country === ctxCountry)) score += 12;
  if (targetLoc.region && (targetLoc.region === userLoc.region || targetLoc.region === ctxRegion)) score += 10;
  if (targetLoc.city && (targetLoc.city === userLoc.city || targetLoc.city === ctxCity)) score += 14;
  if (targetLoc.raw && (targetLoc.raw === userLoc.raw || targetLoc.raw === ctxCity || targetLoc.raw === ctxRegion || targetLoc.raw === ctxCountry)) score += 15;

  return score;
}

function getTargetMatchScore(ad: any, user: UserAdProfile, context: AdContext) {
  const target = (ad.targetAudience || {}) as any;
  let score = 0;

  const userInterests = user.interests.map(normalizeText);
  const targetInterests = toArray<string>(target.interests).map(normalizeText);
  const interestMatches = matchesAny(userInterests, targetInterests);
  score += Math.min(35, interestMatches.length * 10);

  const purchaseCategories = toArray<any>(user.purchaseHistory)
    .map(item => normalizeText(item?.categoryId || item?.category || item?.type))
    .filter(Boolean);

  const targetCategories = unique([
    ...toArray<string>(target.categories),
    normalizeText(ad.categoryId)
  ].filter(Boolean));

  score += Math.min(24, matchesAny(purchaseCategories, targetCategories).length * 8);

  const recentCategories = user.recentlyViewedCategories.map(normalizeText);
  if (context.categoryId && targetCategories.includes(normalizeText(context.categoryId))) score += 16;
  score += Math.min(18, matchesAny(recentCategories, targetCategories).length * 6);

  const recentProducts = user.recentlyViewedProducts.map(normalizeText);
  const targetProducts = unique([
    ...toArray<string>(target.products),
    normalizeText(ad.productId)
  ].filter(Boolean));

  if (context.productId && targetProducts.includes(normalizeText(context.productId))) score += 20;
  score += Math.min(15, matchesAny(recentProducts, targetProducts).length * 5);

  if (context.storeId && ad.storeId === context.storeId) score += 26;

  const targetScreens = toArray<string>(target.screens).map(normalizeText);
  if (targetScreens.length && targetScreens.includes(normalizeText(context.screen))) score += 14;
  if (!targetScreens.length && ad.screen && normalizeText(ad.screen) === normalizeText(context.screen)) score += 8;

  const targetPlacements = toArray<string>(target.placements).map(normalizeText);
  if (context.placement && targetPlacements.length && targetPlacements.includes(normalizeText(context.placement))) score += 12;
  if (context.placement && !targetPlacements.length && ad.placement && normalizeText(ad.placement) === normalizeText(context.placement)) score += 8;

  const targetLanguages = toArray<string>(target.languages).map(normalizeText);
  if (targetLanguages.length && user.language && targetLanguages.includes(normalizeText(user.language))) score += 8;

  const minAge = target.minAge == null ? null : safeNumber(target.minAge);
  const maxAge = target.maxAge == null ? null : safeNumber(target.maxAge);

  if (user.age != null && minAge != null && user.age >= minAge) score += 4;
  if (user.age != null && maxAge != null && user.age <= maxAge) score += 4;

  score += getUserLocationScore(user.location, target.location, context);

  return score;
}

function getPerformanceScore(ad: any) {
  const ctr = calculateCTR(ad);
  const cvr = calculateCVR(ad);
  const qualityScore = clamp(safeNumber(ad.qualityScore, 50), MIN_QUALITY_SCORE, MAX_QUALITY_SCORE);
  const createdAt = new Date(ad.createdAt || Date.now()).getTime();
  const freshnessHours = Math.max(1, (Date.now() - createdAt) / 3600000);
  const freshnessBoost = 12 * Math.exp(-freshnessHours / 72);
  const ctrScore = clamp(ctr * 1000, 0, 30);
  const cvrScore = clamp(cvr * 700, 0, 30);
  const quality = qualityScore * 0.35;
  return ctrScore + cvrScore + quality + freshnessBoost;
}

function getBidScore(ad: any) {
  const bid = getBidAmount(ad);
  if (bid <= 0) return 0;
  return clamp(Math.log10(bid + 1) * 18, 0, 28);
}

function getPacingScore(ad: any) {
  const budget = safeNumber(ad.budget);
  if (budget <= 0) return 8;

  const spend = calculateSpend(ad);
  const remainingRatio = clamp((budget - spend) / budget, 0, 1);
  const start = new Date(ad.startDate || ad.createdAt || Date.now()).getTime();
  const end = new Date(ad.endDate || Date.now()).getTime();
  const now = Date.now();
  const duration = Math.max(1, end - start);
  const elapsedRatio = clamp((now - start) / duration, 0, 1);
  const idealRemaining = 1 - elapsedRatio;
  const diff = Math.abs(remainingRatio - idealRemaining);

  return clamp(14 - diff * 18, -8, 14);
}

function getDiversityPenalty(ad: any, alreadySelected: any[]) {
  let penalty = 0;
  if (alreadySelected.some(item => item.storeId && item.storeId === ad.storeId)) penalty += 18;
  if (alreadySelected.some(item => item.categoryId && item.categoryId === ad.categoryId)) penalty += 8;
  return penalty;
}

function getRandomFairnessBoost(adId: string, userId: string) {
  const seed = `${adId}:${userId}:${new Date().toISOString().slice(0, 10)}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return (Math.abs(hash % 1000) / 1000) * 4;
}

function buildUserAdProfile(user: any): UserAdProfile {
  return {
    interests: toArray<string>(user?.interests),
    location: user?.location || null,
    purchaseHistory: toArray<any>(user?.purchaseHistory),
    recentlyViewedCategories: toArray<string>(user?.recentlyViewedCategories || user?.viewedCategories),
    recentlyViewedProducts: toArray<string>(user?.recentlyViewedProducts || user?.viewedProducts),
    blockedStores: unique(toArray<string>(user?.blockedStores || user?.blockedStoreIds).filter(Boolean)),
    age: user?.age ?? null,
    language: user?.language ?? null
  };
}

function sanitizeAdCreateInput(input: CreateAdvertisementInput) {
  const now = new Date();
  const startDate = safeDate(input.startDate, now);
  const endDate = safeDate(input.endDate, new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));

  if (!cleanString(input.title, 140)) throw new Error('Ad title is required');
  if (endDate <= startDate) throw new Error('Ad endDate must be after startDate');

  return {
    storeId: input.storeId || null,
    advertiserId: input.advertiserId || null,
    title: cleanString(input.title, 140),
    description: cleanNullableString(input.description, 500),
    imageUrl: cleanNullableString(input.imageUrl, 1500),
    videoUrl: cleanNullableString(input.videoUrl, 1500),
    targetUrl: cleanNullableString(input.targetUrl, 1500),
    productId: input.productId || null,
    categoryId: input.categoryId || null,
    placement: cleanNullableString(input.placement, 80),
    screen: cleanNullableString(input.screen, 80),
    pricingModel: normalizeText(input.pricingModel || 'cpm') || 'cpm',
    bidAmount: Math.max(0, safeNumber(input.bidAmount, 0)),
    budget: Math.max(0, safeNumber(input.budget, 0)),
    priority: Math.max(0, Math.floor(safeNumber(input.priority, 0))),
    targetAudience: input.targetAudience || {},
    startDate,
    endDate,
    status: cleanString(input.status || 'draft', 40) || 'draft'
  };
}

function sanitizeAdUpdateInput(input: UpdateAdvertisementInput) {
  const data: Record<string, any> = {};

  if (input.storeId !== undefined) data.storeId = input.storeId || null;
  if (input.advertiserId !== undefined) data.advertiserId = input.advertiserId || null;
  if (input.title !== undefined) data.title = cleanString(input.title, 140);
  if (input.description !== undefined) data.description = cleanNullableString(input.description, 500);
  if (input.imageUrl !== undefined) data.imageUrl = cleanNullableString(input.imageUrl, 1500);
  if (input.videoUrl !== undefined) data.videoUrl = cleanNullableString(input.videoUrl, 1500);
  if (input.targetUrl !== undefined) data.targetUrl = cleanNullableString(input.targetUrl, 1500);
  if (input.productId !== undefined) data.productId = input.productId || null;
  if (input.categoryId !== undefined) data.categoryId = input.categoryId || null;
  if (input.placement !== undefined) data.placement = cleanNullableString(input.placement, 80);
  if (input.screen !== undefined) data.screen = cleanNullableString(input.screen, 80);
  if (input.pricingModel !== undefined) data.pricingModel = normalizeText(input.pricingModel || 'cpm') || 'cpm';
  if (input.bidAmount !== undefined) data.bidAmount = Math.max(0, safeNumber(input.bidAmount, 0));
  if (input.budget !== undefined) data.budget = Math.max(0, safeNumber(input.budget, 0));
  if (input.priority !== undefined) data.priority = Math.max(0, Math.floor(safeNumber(input.priority, 0)));
  if (input.targetAudience !== undefined) data.targetAudience = input.targetAudience || {};
  if (input.startDate !== undefined) data.startDate = safeDate(input.startDate, new Date());
  if (input.endDate !== undefined) data.endDate = safeDate(input.endDate, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  if (input.status !== undefined) data.status = cleanString(input.status, 40);

  if (data.title !== undefined && !data.title) throw new Error('Ad title is required');
  if (data.startDate && data.endDate && data.endDate <= data.startDate) throw new Error('Ad endDate must be after startDate');

  return data;
}

async function getUserFrequencyMap(userId: string, adIds: string[]) {
  if (!userId || !adIds.length) return new Map<string, any>();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const events = await (prisma as any).adEvent.groupBy({
    by: ['adId', 'eventType'],
    where: {
      userId,
      adId: { in: adIds },
      createdAt: { gte: since }
    },
    _count: { _all: true }
  }).catch(() => []);

  const map = new Map<string, any>();

  for (const row of events as any[]) {
    const current = map.get(row.adId) || { impressions: 0, clicks: 0, conversions: 0 };
    if (row.eventType === 'impression') current.impressions = row._count?._all || 0;
    if (row.eventType === 'click') current.clicks = row._count?._all || 0;
    if (row.eventType === 'conversion') current.conversions = row._count?._all || 0;
    map.set(row.adId, current);
  }

  return map;
}

async function createAdEvent(adId: string, eventType: AdEventType, meta: any = {}) {
  return (prisma as any).adEvent.create({
    data: {
      adId,
      userId: meta.userId || null,
      eventType,
      screen: meta.screen || null,
      placement: meta.placement || null,
      storeId: meta.storeId || null,
      productId: meta.productId || null,
      sessionId: meta.sessionId || null,
      device: meta.device || null,
      metadata: meta.metadata || {}
    } as any
  }).catch(() => null);
}

async function invalidateAdCaches(adId?: string) {
  await Promise.all([
    cache.delete('ads:active').catch(() => null),
    adId ? cache.delete(`ad:performance:${adId}`).catch(() => null) : Promise.resolve()
  ]);
}

export async function createAdvertisement(input: CreateAdvertisementInput) {
  const data = sanitizeAdCreateInput(input);

  const ad = await (prisma as any).advertisement.create({
    data: {
      ...data,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      engagementScore: 0,
      qualityScore: 50
    } as any
  });

  await invalidateAdCaches(ad.id);
  return ad;
}

export async function updateAdvertisement(adId: string, input: UpdateAdvertisementInput) {
  if (!adId) throw new Error('adId is required');

  const data = sanitizeAdUpdateInput(input);

  const ad = await (prisma as any).advertisement.update({
    where: { id: adId },
    data: data as any
  });

  await invalidateAdCaches(adId);
  return ad;
}

export async function activateAdvertisement(adId: string) {
  if (!adId) throw new Error('adId is required');

  const ad = await (prisma as any).advertisement.update({
    where: { id: adId },
    data: { status: ACTIVE_STATUS } as any
  });

  await invalidateAdCaches(adId);
  return ad;
}

export async function pauseAdvertisement(adId: string) {
  if (!adId) throw new Error('adId is required');

  const ad = await (prisma as any).advertisement.update({
    where: { id: adId },
    data: { status: 'paused' } as any
  });

  await invalidateAdCaches(adId);
  return ad;
}

export async function stopAdvertisement(adId: string) {
  if (!adId) throw new Error('adId is required');

  const ad = await (prisma as any).advertisement.update({
    where: { id: adId },
    data: { status: 'ended', endDate: new Date() } as any
  });

  await invalidateAdCaches(adId);
  return ad;
}

export async function getTargetedAds(userId: string, context: AdContext = { screen: 'home' }) {
  const now = new Date();
  const limit = clamp(safeNumber(context.limit, DEFAULT_LIMIT), 1, MAX_LIMIT);
  const excludeAdIds = unique(toArray<string>(context.excludeAdIds).filter(Boolean));
  const cacheKey = `ads:targeted:${userId || 'guest'}:${normalizeText(context.screen)}:${normalizeText(context.placement)}:${normalizeText(context.storeId)}:${normalizeText(context.categoryId)}:${normalizeText(context.productId)}:${limit}:${excludeAdIds.join(',')}`;

  const cached = await cache.get<any[]>(cacheKey).catch(() => null);
  if (cached) return cached;

  const userRaw = userId
    ? await (prisma as any).user.findUnique({
        where: { id: userId },
        select: {
          interests: true,
          location: true,
          purchaseHistory: true,
          recentlyViewedCategories: true,
          recentlyViewedProducts: true,
          blockedStores: true,
          blockedStoreIds: true,
          age: true,
          language: true
        } as any
      }).catch(() => null)
    : null;

  const user = buildUserAdProfile(userRaw);

  const activeAds = await (prisma as any).advertisement.findMany({
    where: {
      ...getActiveWindowFilter(now),
      id: excludeAdIds.length ? { notIn: excludeAdIds } : undefined,
      storeId: user.blockedStores.length ? { notIn: user.blockedStores } : undefined
    } as any,
    orderBy: [
      { priority: 'desc' } as any,
      { createdAt: 'desc' } as any
    ],
    take: Math.max(limit * 10, 50)
  }).catch(() => []);

  const adIds = activeAds.map((ad: any) => ad.id);
  const frequencyMap = await getUserFrequencyMap(userId, adIds);

  const eligible = activeAds.filter((ad: any) => {
    if (!hasBudget(ad)) return false;
    if (!isWithinFrequencyCap(ad, frequencyMap.get(ad.id))) return false;

    const target = (ad.targetAudience || {}) as any;
    const excludedUsers = toArray<string>(target.excludedUsers);
    if (userId && excludedUsers.includes(userId)) return false;

    const includedUsers = toArray<string>(target.includedUsers);
    if (userId && includedUsers.length && !includedUsers.includes(userId)) return false;

    const targetStores = toArray<string>(target.stores);
    if (context.storeId && targetStores.length && !targetStores.includes(context.storeId)) return false;

    return true;
  });

  const scored = eligible
    .map((ad: any) => {
      const relevanceScore = getTargetMatchScore(ad, user, context);
      const performanceScore = getPerformanceScore(ad);
      const bidScore = getBidScore(ad);
      const pacingScore = getPacingScore(ad);
      const priorityScore = safeNumber(ad.priority) * 6;
      const fairnessBoost = getRandomFairnessBoost(ad.id, userId || 'guest');
      const score = relevanceScore * 0.48 + performanceScore * 0.24 + bidScore * 0.14 + pacingScore * 0.08 + priorityScore + fairnessBoost;

      return { ad, score };
    })
    .sort((a: any, b: any) => b.score - a.score);

  const selected: any[] = [];

  for (const item of scored) {
    const penalty = getDiversityPenalty(item.ad, selected);
    const adjustedScore = item.score - penalty;

    if (adjustedScore >= 0 || selected.length < Math.min(2, limit)) {
      selected.push({
        ...item.ad,
        adRankScore: Number(adjustedScore.toFixed(4))
      });
    }

    if (selected.length >= limit) break;
  }

  await cache.set(cacheKey, selected, CACHE_TTL).catch(() => null);
  return selected;
}

export async function trackAdEvent(adId: string, eventType: AdEventType, meta: any = {}) {
  if (!adId) throw new Error('adId is required');
  if (!['impression', 'click', 'conversion'].includes(eventType)) throw new Error('Invalid ad event');

  const field = eventType === 'impression' ? 'impressions' : eventType === 'click' ? 'clicks' : 'conversions';
  const weight = eventType === 'impression' ? IMPRESSION_WEIGHT : eventType === 'click' ? CLICK_WEIGHT : CONVERSION_WEIGHT;

  const result = await prisma.$transaction(async tx => {
    const ad = await (tx as any).advertisement.update({
      where: { id: adId },
      data: {
        [field]: { increment: 1 },
        engagementScore: { increment: weight },
        lastEngagedAt: eventType === 'click' || eventType === 'conversion' ? new Date() : undefined,
        qualityScore: eventType === 'conversion' ? { increment: 2 } : eventType === 'click' ? { increment: 0.5 } : undefined
      } as any
    });

    await (tx as any).adEvent.create({
      data: {
        adId,
        userId: meta.userId || null,
        eventType,
        screen: meta.screen || null,
        placement: meta.placement || null,
        storeId: meta.storeId || null,
        productId: meta.productId || null,
        sessionId: meta.sessionId || null,
        device: meta.device || null,
        metadata: meta.metadata || {}
      } as any
    }).catch(() => null);

    return ad;
  });

  await invalidateAdCaches(adId);
  return result;
}

export async function trackAdImpressions(adIds: string[], meta: any = {}) {
  const ids = unique(toArray<string>(adIds).filter(Boolean));
  if (!ids.length) return { updated: 0 };

  await (prisma as any).advertisement.updateMany({
    where: { id: { in: ids } },
    data: {
      impressions: { increment: 1 },
      engagementScore: { increment: IMPRESSION_WEIGHT }
    } as any
  });

  await Promise.all(ids.map(adId => createAdEvent(adId, 'impression', meta)));
  await invalidateAdCaches();

  return { updated: ids.length };
}

export async function trackAdClick(adId: string, meta: any = {}) {
  return trackAdEvent(adId, 'click', meta);
}

export async function trackAdConversion(adId: string, meta: any = {}) {
  return trackAdEvent(adId, 'conversion', meta);
}

export async function getAdPerformance(adId: string) {
  if (!adId) throw new Error('adId is required');

  const cacheKey = `ad:performance:${adId}`;
  const cached = await cache.get<any>(cacheKey).catch(() => null);
  if (cached) return cached;

  const ad = await (prisma as any).advertisement.findUnique({ where: { id: adId } });
  if (!ad) return null;

  const impressions = safeNumber(ad.impressions);
  const clicks = safeNumber(ad.clicks);
  const conversions = safeNumber(ad.conversions);
  const spend = calculateSpend(ad);
  const budget = safeNumber(ad.budget);

  const performance = {
    adId,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    conversionRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
    spend: Number(spend.toFixed(2)),
    remainingBudget: Math.max(0, budget - spend),
    budget,
    budgetUsedPercent: budget > 0 ? Number(clamp((spend / budget) * 100, 0, 100).toFixed(2)) : 0,
    qualityScore: clamp(safeNumber(ad.qualityScore, 50), MIN_QUALITY_SCORE, MAX_QUALITY_SCORE),
    engagementScore: safeNumber(ad.engagementScore),
    status: ad.status,
    startDate: ad.startDate,
    endDate: ad.endDate
  };

  await cache.set(cacheKey, performance, 30).catch(() => null);
  return performance;
}

export async function refreshAdQualityScore(adId: string) {
  if (!adId) throw new Error('adId is required');

  const ad = await (prisma as any).advertisement.findUnique({ where: { id: adId } });
  if (!ad) return null;

  const ctr = calculateCTR(ad);
  const cvr = calculateCVR(ad);
  const impressions = safeNumber(ad.impressions);
  const base = 45;
  const ctrBoost = clamp(ctr * 900, 0, 25);
  const cvrBoost = clamp(cvr * 800, 0, 25);
  const confidencePenalty = impressions < 100 ? 10 : impressions < 500 ? 5 : 0;
  const score = clamp(base + ctrBoost + cvrBoost - confidencePenalty, MIN_QUALITY_SCORE, MAX_QUALITY_SCORE);

  const updated = await (prisma as any).advertisement.update({
    where: { id: adId },
    data: { qualityScore: Number(score.toFixed(2)) } as any
  });

  await invalidateAdCaches(adId);
  return updated;
}

export async function refreshAllActiveAdQualityScores(limit = 200) {
  const ads = await (prisma as any).advertisement.findMany({
    where: { status: ACTIVE_STATUS },
    select: { id: true },
    take: clamp(safeNumber(limit, 200), 1, 1000),
    orderBy: { updatedAt: 'desc' }
  }).catch(() => []);

  const results = [];

  for (const ad of ads) {
    results.push(await refreshAdQualityScore(ad.id).catch(error => ({ id: ad.id, error: error?.message || 'failed' })));
  }

  return results;
}

export async function getAdvertiserAds(advertiserId: string, limit = 50) {
  if (!advertiserId) throw new Error('advertiserId is required');

  return (prisma as any).advertisement.findMany({
    where: { advertiserId },
    orderBy: [{ createdAt: 'desc' }],
    take: clamp(safeNumber(limit, 50), 1, 200)
  });
}

export async function getStoreAds(storeId: string, limit = 50) {
  if (!storeId) throw new Error('storeId is required');

  return (prisma as any).advertisement.findMany({
    where: { storeId },
    orderBy: [{ createdAt: 'desc' }],
    take: clamp(safeNumber(limit, 50), 1, 200)
  });
}

export async function getAdEvents(adId: string, limit = 100) {
  if (!adId) throw new Error('adId is required');

  return (prisma as any).adEvent.findMany({
    where: { adId },
    orderBy: { createdAt: 'desc' },
    take: clamp(safeNumber(limit, 100), 1, 500)
  }).catch(() => []);
}

export async function getAdEventSummary(adId: string, days = 7) {
  if (!adId) throw new Error('adId is required');

  const since = new Date(Date.now() - clamp(safeNumber(days, 7), 1, 90) * 24 * 60 * 60 * 1000);

  const rows = await (prisma as any).adEvent.groupBy({
    by: ['eventType'],
    where: {
      adId,
      createdAt: { gte: since }
    },
    _count: { _all: true }
  }).catch(() => []);

  const summary = {
    adId,
    impressions: 0,
    clicks: 0,
    conversions: 0
  };

  for (const row of rows as any[]) {
    if (row.eventType === 'impression') summary.impressions = row._count?._all || 0;
    if (row.eventType === 'click') summary.clicks = row._count?._all || 0;
    if (row.eventType === 'conversion') summary.conversions = row._count?._all || 0;
  }

  return {
    ...summary,
    ctr: summary.impressions > 0 ? Number(((summary.clicks / summary.impressions) * 100).toFixed(2)) : 0,
    conversionRate: summary.clicks > 0 ? Number(((summary.conversions / summary.clicks) * 100).toFixed(2)) : 0
  };
}

export async function deleteAdvertisement(adId: string) {
  if (!adId) throw new Error('adId is required');

  const deleted = await (prisma as any).advertisement.delete({
    where: { id: adId }
  });

  await invalidateAdCaches(adId);
  return deleted;
}
