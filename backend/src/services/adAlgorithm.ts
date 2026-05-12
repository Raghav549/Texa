import { prisma } from '../config/db';

type AdEventType = 'impression' | 'click' | 'conversion';

type AdContext = {
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
};

type UserAdProfile = {
  interests: string[];
  location: any;
  purchaseHistory: any[];
  recentlyViewedCategories: string[];
  recentlyViewedProducts: string[];
  blockedStores: string[];
  age?: number | null;
  language?: string | null;
};

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const IMPRESSION_WEIGHT = 1;
const CLICK_WEIGHT = 8;
const CONVERSION_WEIGHT = 35;
const MIN_QUALITY_SCORE = 0;
const MAX_QUALITY_SCORE = 100;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value: any) {
  return String(value || '').trim().toLowerCase();
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function safeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const set = new Set(source.map(normalizeText));
  return target.map(normalizeText).filter(item => set.has(item));
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

function calculateSpend(ad: any) {
  const pricingModel = normalizeText(ad.pricingModel || ad.billingModel || 'cpm');
  const bidAmount = safeNumber(ad.bidAmount || ad.cpm || ad.cpc || ad.cpa);
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
  const cap = safeNumber(target?.frequencyCap || ad.frequencyCap, 0);
  if (cap <= 0) return true;
  return safeNumber(frequency?.impressions) < cap;
}

function getActiveWindowFilter(now: Date) {
  return {
    status: 'active',
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

  const targetPlacements = toArray<string>(target.placements).map(normalizeText);
  if (context.placement && targetPlacements.length && targetPlacements.includes(normalizeText(context.placement))) score += 12;

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
  const freshnessHours = Math.max(1, (Date.now() - new Date(ad.createdAt || Date.now()).getTime()) / 3600000);
  const freshnessBoost = 12 * Math.exp(-freshnessHours / 72);
  const ctrScore = clamp(ctr * 1000, 0, 30);
  const cvrScore = clamp(cvr * 700, 0, 30);
  const quality = qualityScore * 0.35;
  return ctrScore + cvrScore + quality + freshnessBoost;
}

function getBidScore(ad: any) {
  const bid = safeNumber(ad.bidAmount || ad.cpm || ad.cpc || ad.cpa);
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
  return Math.abs(hash % 1000) / 1000 * 4;
}

function buildUserAdProfile(user: any): UserAdProfile {
  return {
    interests: toArray<string>(user?.interests),
    location: user?.location || null,
    purchaseHistory: toArray<any>(user?.purchaseHistory),
    recentlyViewedCategories: toArray<string>(user?.recentlyViewedCategories || user?.viewedCategories),
    recentlyViewedProducts: toArray<string>(user?.recentlyViewedProducts || user?.viewedProducts),
    blockedStores: toArray<string>(user?.blockedStores || user?.blockedStoreIds),
    age: user?.age ?? null,
    language: user?.language ?? null
  };
}

async function getUserFrequencyMap(userId: string, adIds: string[]) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await prisma.adEvent.groupBy({
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
  return prisma.adEvent.create({
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
    }
  }).catch(() => null);
}

export async function getTargetedAds(userId: string, context: AdContext = { screen: 'home' }) {
  const now = new Date();
  const limit = clamp(safeNumber(context.limit, DEFAULT_LIMIT), 1, MAX_LIMIT);
  const excludeAdIds = toArray<string>(context.excludeAdIds);

  const userRaw = await prisma.user.findUnique({
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
  });

  const user = buildUserAdProfile(userRaw);

  const activeAds = await prisma.advertisement.findMany({
    where: {
      ...getActiveWindowFilter(now),
      id: excludeAdIds.length ? { notIn: excludeAdIds } : undefined,
      storeId: user.blockedStores.length ? { notIn: user.blockedStores } : undefined
    },
    orderBy: [
      { priority: 'desc' } as any,
      { createdAt: 'desc' }
    ],
    take: Math.max(limit * 8, 40)
  });

  const adIds = activeAds.map(ad => ad.id);
  const frequencyMap = await getUserFrequencyMap(userId, adIds);

  const eligible = activeAds.filter(ad => {
    if (!hasBudget(ad)) return false;
    if (!isWithinFrequencyCap(ad, frequencyMap.get(ad.id))) return false;
    const target = (ad.targetAudience || {}) as any;
    const excludedUsers = toArray<string>(target.excludedUsers);
    if (excludedUsers.includes(userId)) return false;
    const includedUsers = toArray<string>(target.includedUsers);
    if (includedUsers.length && !includedUsers.includes(userId)) return false;
    return true;
  });

  const scored = eligible.map(ad => {
    const relevanceScore = getTargetMatchScore(ad, user, context);
    const performanceScore = getPerformanceScore(ad);
    const bidScore = getBidScore(ad);
    const pacingScore = getPacingScore(ad);
    const priorityScore = safeNumber((ad as any).priority) * 6;
    const fairnessBoost = getRandomFairnessBoost(ad.id, userId);
    const score = relevanceScore * 0.48 + performanceScore * 0.24 + bidScore * 0.14 + pacingScore * 0.08 + priorityScore + fairnessBoost;
    return { ad, score };
  }).sort((a, b) => b.score - a.score);

  const selected: any[] = [];
  for (const item of scored) {
    const penalty = getDiversityPenalty(item.ad, selected);
    const adjustedScore = item.score - penalty;
    if (adjustedScore >= 0 || selected.length < Math.min(2, limit)) {
      selected.push({ ...item.ad, adRankScore: Number(adjustedScore.toFixed(4)) });
    }
    if (selected.length >= limit) break;
  }

  return selected;
}

export async function trackAdEvent(adId: string, eventType: AdEventType, meta: any = {}) {
  const field =
    eventType === 'impression'
      ? 'impressions'
      : eventType === 'click'
        ? 'clicks'
        : 'conversions';

  const weight =
    eventType === 'impression'
      ? IMPRESSION_WEIGHT
      : eventType === 'click'
        ? CLICK_WEIGHT
        : CONVERSION_WEIGHT;

  const result = await prisma.$transaction(async tx => {
    const ad = await tx.advertisement.update({
      where: { id: adId },
      data: {
        [field]: { increment: 1 },
        engagementScore: { increment: weight }
      } as any
    });

    await tx.adEvent.create({
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

  if (eventType === 'click' || eventType === 'conversion') {
    await prisma.advertisement.update({
      where: { id: adId },
      data: {
        lastEngagedAt: new Date(),
        qualityScore: {
          increment: eventType === 'conversion' ? 2 : 0.5
        }
      } as any
    }).catch(() => null);
  }

  return result;
}

export async function trackAdImpressions(adIds: string[], meta: any = {}) {
  const ids = unique(toArray<string>(adIds).filter(Boolean));
  if (!ids.length) return { updated: 0 };

  await prisma.advertisement.updateMany({
    where: { id: { in: ids } },
    data: {
      impressions: { increment: 1 },
      engagementScore: { increment: IMPRESSION_WEIGHT }
    } as any
  });

  await Promise.all(ids.map(adId => createAdEvent(adId, 'impression', meta)));

  return { updated: ids.length };
}

export async function getAdPerformance(adId: string) {
  const ad = await prisma.advertisement.findUnique({ where: { id: adId } });
  if (!ad) return null;

  const impressions = safeNumber((ad as any).impressions);
  const clicks = safeNumber((ad as any).clicks);
  const conversions = safeNumber((ad as any).conversions);
  const spend = calculateSpend(ad);

  return {
    adId,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    conversionRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
    spend: Number(spend.toFixed(2)),
    remainingBudget: Math.max(0, safeNumber((ad as any).budget) - spend),
    qualityScore: clamp(safeNumber((ad as any).qualityScore, 50), MIN_QUALITY_SCORE, MAX_QUALITY_SCORE),
    engagementScore: safeNumber((ad as any).engagementScore)
  };
}

export async function refreshAdQualityScore(adId: string) {
  const ad = await prisma.advertisement.findUnique({ where: { id: adId } });
  if (!ad) return null;

  const ctr = calculateCTR(ad);
  const cvr = calculateCVR(ad);
  const impressions = safeNumber((ad as any).impressions);
  const base = 45;
  const ctrBoost = clamp(ctr * 900, 0, 25);
  const cvrBoost = clamp(cvr * 800, 0, 25);
  const confidencePenalty = impressions < 100 ? 10 : impressions < 500 ? 5 : 0;
  const score = clamp(base + ctrBoost + cvrBoost - confidencePenalty, MIN_QUALITY_SCORE, MAX_QUALITY_SCORE);

  return prisma.advertisement.update({
    where: { id: adId },
    data: { qualityScore: Number(score.toFixed(2)) } as any
  });
}
