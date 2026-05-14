import { prisma } from '../config/db';
import { cache } from '../config/redis';

type PrestigeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'royal' | 'legendary';

type PrestigeBadge = {
  id: string;
  label: string;
  type: 'identity' | 'creator' | 'commerce' | 'social' | 'trust' | 'activity' | 'premium';
  level: number;
};

type PrestigeData = {
  id: string;
  fullName: string | null;
  username: string | null;
  bio: string | null;
  dob: Date | null;
  avatar: string | null;
  coverUrl: string | null;
  xp: number;
  level: string | number | null;
  coins: number;
  isVerified: boolean;
  role: string | null;
  followers: number;
  following: number;
  posts: number;
  reels: number;
  stories: number;
  products: number;
  stores: number;
  roomsHosted: number;
  giftsReceived: number;
  giftCoinsReceived: number;
  totalEarnings: number;
  profileCompletion: number;
  trustScore: number;
  prestigeScore: number;
  prestigeTier: PrestigeTier;
  badges: PrestigeBadge[];
  creatorEconomy: {
    totalEarnings: number;
    giftsReceived: number;
    giftsSent: number;
    giftCoinsReceived: number;
    giftCoinsSent: number;
  };
  business: {
    hasBusinessProfile: boolean;
    isStoreVerified: boolean;
    verificationStatus: string | null;
    storeName: string | null;
  };
  socialProof: {
    followerRatio: number;
    engagementPower: number;
    creatorPower: number;
    commercePower: number;
  };
  generatedAt: string;
};

const PRESTIGE_CACHE_TTL = 60;

const safeNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const toArray = <T = any>(value: any): T[] => Array.isArray(value) ? value : [];

const countArray = (value: any) => toArray(value).length;

const logScore = (value: number, multiplier: number) => Math.log10(Math.max(0, value) + 1) * multiplier;

const cacheKey = (userId: string) => `prestige:data:${userId}`;

async function safeCount(modelName: string, where: any) {
  const model = (prisma as any)[modelName];
  if (!model?.count) return 0;
  return model.count({ where }).catch(() => 0);
}

async function safeFindFirst(modelName: string, args: any) {
  const model = (prisma as any)[modelName];
  if (!model?.findFirst) return null;
  return model.findFirst(args).catch(() => null);
}

async function safeFindUnique(modelName: string, args: any) {
  const model = (prisma as any)[modelName];
  if (!model?.findUnique) return null;
  return model.findUnique(args).catch(() => null);
}

function getPrestigeTier(score: number): PrestigeTier {
  if (score >= 950) return 'legendary';
  if (score >= 800) return 'royal';
  if (score >= 650) return 'diamond';
  if (score >= 500) return 'platinum';
  if (score >= 330) return 'gold';
  if (score >= 180) return 'silver';
  return 'bronze';
}

function getProfileCompletion(user: any, businessProfile: any) {
  const fields = [
    user.fullName,
    user.username,
    user.bio,
    user.avatarUrl,
    user.coverUrl,
    user.dob,
    user.language,
    user.region,
    user.isVerified ? 'verified' : null,
    businessProfile?.storeName || businessProfile?.businessName || businessProfile?.name
  ];

  const completed = fields.filter(Boolean).length;
  return Math.round((completed / fields.length) * 100);
}

function getTrustScore(user: any, businessProfile: any, counts: any) {
  let score = 30;

  if (user.isVerified) score += 20;
  if (businessProfile?.verificationStatus === 'VERIFIED' || businessProfile?.verificationStatus === 'verified') score += 18;
  if (user.emailVerified || user.isEmailVerified) score += 8;
  if (user.phoneVerified || user.isPhoneVerified) score += 8;
  if (safeNumber(user.xp) >= 1000) score += 6;
  if (counts.followers >= 100) score += 4;
  if (counts.reels + counts.posts >= 20) score += 4;
  if (counts.products >= 5) score += 2;

  return clamp(Math.round(score), 0, 100);
}

function calculatePrestigeScore(user: any, counts: any, creatorEconomy: any, profileCompletion: number, trustScore: number) {
  const xp = safeNumber(user.xp);
  const coins = safeNumber(user.coins);
  const levelValue = typeof user.level === 'number' ? user.level : safeNumber(String(user.level || '').replace(/[^\d.]/g, ''), 0);
  const followers = safeNumber(counts.followers);
  const following = safeNumber(counts.following);
  const reels = safeNumber(counts.reels);
  const posts = safeNumber(counts.posts);
  const stories = safeNumber(counts.stories);
  const products = safeNumber(counts.products);
  const stores = safeNumber(counts.stores);
  const roomsHosted = safeNumber(counts.roomsHosted);
  const giftsReceived = safeNumber(creatorEconomy?.giftsReceived);
  const giftCoinsReceived = safeNumber(creatorEconomy?.giftCoinsReceived);
  const totalEarnings = safeNumber(creatorEconomy?.totalEarnings);
  const followerRatio = followers / Math.max(1, following);

  const score =
    logScore(xp, 80) +
    logScore(coins, 18) +
    levelValue * 12 +
    logScore(followers, 90) +
    clamp(followerRatio, 0, 8) * 10 +
    logScore(reels, 35) +
    logScore(posts, 25) +
    logScore(stories, 12) +
    logScore(products, 28) +
    logScore(stores, 18) +
    logScore(roomsHosted, 28) +
    logScore(giftsReceived, 35) +
    logScore(giftCoinsReceived, 45) +
    logScore(totalEarnings, 35) +
    profileCompletion * 1.2 +
    trustScore * 1.6 +
    (user.isVerified ? 80 : 0);

  return Math.round(clamp(score, 0, 1200));
}

function buildBadges(user: any, counts: any, creatorEconomy: any, businessProfile: any, profileCompletion: number, trustScore: number, prestigeScore: number): PrestigeBadge[] {
  const badges: PrestigeBadge[] = [];

  if (user.isVerified) {
    badges.push({ id: 'verified_identity', label: 'Verified Identity', type: 'identity', level: 5 });
  }

  if (profileCompletion >= 90) {
    badges.push({ id: 'complete_profile', label: 'Complete Profile', type: 'identity', level: 3 });
  }

  if (trustScore >= 85) {
    badges.push({ id: 'trusted_member', label: 'Trusted Member', type: 'trust', level: 5 });
  }

  if (safeNumber(counts.followers) >= 1000) {
    badges.push({ id: 'rising_influencer', label: 'Rising Influencer', type: 'social', level: 4 });
  } else if (safeNumber(counts.followers) >= 100) {
    badges.push({ id: 'social_builder', label: 'Social Builder', type: 'social', level: 2 });
  }

  if (safeNumber(counts.reels) >= 100) {
    badges.push({ id: 'reel_master', label: 'Reel Master', type: 'creator', level: 5 });
  } else if (safeNumber(counts.reels) >= 20) {
    badges.push({ id: 'active_creator', label: 'Active Creator', type: 'creator', level: 3 });
  }

  if (safeNumber(creatorEconomy?.giftCoinsReceived) >= 10000) {
    badges.push({ id: 'gift_magnet', label: 'Gift Magnet', type: 'creator', level: 5 });
  } else if (safeNumber(creatorEconomy?.giftsReceived) >= 25) {
    badges.push({ id: 'gifted_creator', label: 'Gifted Creator', type: 'creator', level: 3 });
  }

  if (businessProfile?.verificationStatus === 'VERIFIED' || businessProfile?.verificationStatus === 'verified' || businessProfile?.isVerified) {
    badges.push({ id: 'verified_store', label: 'Verified Store', type: 'commerce', level: 5 });
  }

  if (safeNumber(counts.products) >= 20) {
    badges.push({ id: 'commerce_builder', label: 'Commerce Builder', type: 'commerce', level: 4 });
  }

  if (safeNumber(counts.roomsHosted) >= 25) {
    badges.push({ id: 'voice_host', label: 'Voice Host', type: 'activity', level: 4 });
  }

  if (prestigeScore >= 800) {
    badges.push({ id: 'royal_prestige', label: 'Royal Prestige', type: 'premium', level: 5 });
  } else if (prestigeScore >= 500) {
    badges.push({ id: 'premium_presence', label: 'Premium Presence', type: 'premium', level: 4 });
  }

  return badges;
}

function buildSocialProof(counts: any, creatorEconomy: any) {
  const followers = safeNumber(counts.followers);
  const following = safeNumber(counts.following);
  const reels = safeNumber(counts.reels);
  const posts = safeNumber(counts.posts);
  const stories = safeNumber(counts.stories);
  const products = safeNumber(counts.products);
  const roomsHosted = safeNumber(counts.roomsHosted);
  const giftsReceived = safeNumber(creatorEconomy?.giftsReceived);
  const giftCoinsReceived = safeNumber(creatorEconomy?.giftCoinsReceived);
  const totalEarnings = safeNumber(creatorEconomy?.totalEarnings);

  return {
    followerRatio: Number((followers / Math.max(1, following)).toFixed(2)),
    engagementPower: Math.round(logScore(reels + posts + stories, 40) + logScore(followers, 25)),
    creatorPower: Math.round(logScore(giftsReceived, 35) + logScore(giftCoinsReceived, 45) + logScore(roomsHosted, 25)),
    commercePower: Math.round(logScore(products, 35) + logScore(totalEarnings, 35))
  };
}

export async function generatePrestigeData(userId: string): Promise<PrestigeData> {
  if (!userId) throw new Error('User id is required');

  const key = cacheKey(userId);
  const cached = await cache?.get<PrestigeData>(key).catch(() => null);
  if (cached) return cached;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      fullName: true,
      username: true,
      bio: true,
      followers: true,
      following: true,
      dob: true,
      xp: true,
      level: true,
      coins: true,
      isVerified: true,
      avatarUrl: true,
      coverUrl: true,
      role: true,
      language: true,
      region: true,
      emailVerified: true,
      isEmailVerified: true,
      phoneVerified: true,
      isPhoneVerified: true
    } as any
  }).catch(() => null) as any;

  if (!user) throw new Error('User not found');

  const [
    creatorEconomy,
    businessProfile,
    posts,
    reels,
    stories,
    products,
    stores,
    roomsHosted
  ] = await Promise.all([
    safeFindUnique('creatorEconomy', {
      where: { userId },
      select: {
        totalEarnings: true,
        giftsReceived: true,
        giftsSent: true,
        giftCoinsReceived: true,
        giftCoinsSent: true
      }
    }),
    safeFindFirst('businessProfile', {
      where: { userId },
      select: {
        id: true,
        storeName: true,
        businessName: true,
        name: true,
        verificationStatus: true,
        isVerified: true
      } as any
    }),
    safeCount('post', { userId }),
    safeCount('reel', { userId }),
    safeCount('story', { userId }),
    safeCount('product', { sellerId: userId }),
    safeCount('store', { ownerId: userId }),
    safeCount('voiceRoom', { hostId: userId })
  ]);

  const normalizedCreatorEconomy = {
    totalEarnings: safeNumber(creatorEconomy?.totalEarnings),
    giftsReceived: safeNumber(creatorEconomy?.giftsReceived),
    giftsSent: safeNumber(creatorEconomy?.giftsSent),
    giftCoinsReceived: safeNumber(creatorEconomy?.giftCoinsReceived),
    giftCoinsSent: safeNumber(creatorEconomy?.giftCoinsSent)
  };

  const counts = {
    followers: countArray(user.followers),
    following: countArray(user.following),
    posts,
    reels,
    stories,
    products,
    stores,
    roomsHosted
  };

  const profileCompletion = getProfileCompletion(user, businessProfile);
  const trustScore = getTrustScore(user, businessProfile, counts);
  const prestigeScore = calculatePrestigeScore(user, counts, normalizedCreatorEconomy, profileCompletion, trustScore);
  const prestigeTier = getPrestigeTier(prestigeScore);
  const badges = buildBadges(user, counts, normalizedCreatorEconomy, businessProfile, profileCompletion, trustScore, prestigeScore);
  const socialProof = buildSocialProof(counts, normalizedCreatorEconomy);

  const data: PrestigeData = {
    id: user.id,
    fullName: user.fullName || null,
    username: user.username || null,
    bio: user.bio || null,
    followers: counts.followers,
    following: counts.following,
    dob: user.dob || null,
    xp: safeNumber(user.xp),
    level: user.level ?? null,
    coins: safeNumber(user.coins),
    isVerified: !!user.isVerified,
    avatar: user.avatarUrl || null,
    coverUrl: user.coverUrl || null,
    role: user.role || null,
    posts: counts.posts,
    reels: counts.reels,
    stories: counts.stories,
    products: counts.products,
    stores: counts.stores,
    roomsHosted: counts.roomsHosted,
    giftsReceived: normalizedCreatorEconomy.giftsReceived,
    giftCoinsReceived: normalizedCreatorEconomy.giftCoinsReceived,
    totalEarnings: normalizedCreatorEconomy.totalEarnings,
    profileCompletion,
    trustScore,
    prestigeScore,
    prestigeTier,
    badges,
    creatorEconomy: normalizedCreatorEconomy,
    business: {
      hasBusinessProfile: !!businessProfile,
      isStoreVerified: !!businessProfile?.isVerified || businessProfile?.verificationStatus === 'VERIFIED' || businessProfile?.verificationStatus === 'verified',
      verificationStatus: businessProfile?.verificationStatus || null,
      storeName: businessProfile?.storeName || businessProfile?.businessName || businessProfile?.name || null
    },
    socialProof,
    generatedAt: new Date().toISOString()
  };

  await cache?.set(key, data, PRESTIGE_CACHE_TTL).catch(() => undefined);

  return data;
}

export async function clearPrestigeDataCache(userId: string) {
  if (!userId) return false;
  await cache?.delete(cacheKey(userId)).catch(() => undefined);
  return true;
}
