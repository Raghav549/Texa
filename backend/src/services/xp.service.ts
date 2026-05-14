import { prisma } from '../config/db';
import { io } from '../app';

type LevelValue = string | number | null;

type XPReason =
  | 'daily_login'
  | 'post_created'
  | 'reel_created'
  | 'story_created'
  | 'comment_created'
  | 'like_received'
  | 'share_received'
  | 'save_received'
  | 'order_completed'
  | 'task_completed'
  | 'referral'
  | 'admin_adjustment'
  | 'achievement'
  | 'challenge'
  | 'system';

type AddXPOptions = {
  reason?: XPReason | string;
  sourceId?: string | null;
  sourceType?: string | null;
  metadata?: Record<string, any>;
  allowNegative?: boolean;
  notify?: boolean;
  emit?: boolean;
};

type LevelConfig = {
  level: string;
  minXP: number;
  rank: number;
  title: string;
  multiplier: number;
};

const LEVELS: LevelConfig[] = [
  { level: 'BRONZE', minXP: 0, rank: 1, title: 'Bronze', multiplier: 1 },
  { level: 'SILVER', minXP: 100, rank: 2, title: 'Silver', multiplier: 1.05 },
  { level: 'GOLD', minXP: 500, rank: 3, title: 'Gold', multiplier: 1.1 },
  { level: 'PLATINUM', minXP: 1500, rank: 4, title: 'Platinum', multiplier: 1.18 },
  { level: 'DIAMOND', minXP: 5000, rank: 5, title: 'Diamond', multiplier: 1.3 }
];

const normalizeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min = 0, max = Number.MAX_SAFE_INTEGER) => Math.max(min, Math.min(max, value));

const getLevelConfigByXP = (xp: number) => {
  const sorted = [...LEVELS].sort((a, b) => b.minXP - a.minXP);
  return sorted.find(item => xp >= item.minXP) || LEVELS[0];
};

const getLevelConfig = (level: LevelValue) => {
  const normalized = String(level || '').toUpperCase();
  return LEVELS.find(item => item.level === normalized) || LEVELS[0];
};

const getNextLevelConfig = (level: LevelValue) => {
  const current = getLevelConfig(level);
  return LEVELS.find(item => item.rank === current.rank + 1) || null;
};

const getProgress = (xp: number, level: LevelValue) => {
  const current = getLevelConfig(level);
  const next = getNextLevelConfig(level);

  if (!next) {
    return {
      currentXP: xp,
      currentLevelXP: current.minXP,
      nextLevelXP: null,
      remainingXP: 0,
      percent: 100
    };
  }

  const span = Math.max(1, next.minXP - current.minXP);
  const gained = clamp(xp - current.minXP, 0, span);

  return {
    currentXP: xp,
    currentLevelXP: current.minXP,
    nextLevelXP: next.minXP,
    remainingXP: Math.max(0, next.minXP - xp),
    percent: Math.round((gained / span) * 100)
  };
};

async function createXPLog(userId: string, points: number, beforeXP: number, afterXP: number, beforeLevel: any, afterLevel: any, options: AddXPOptions) {
  const data = {
    userId,
    points,
    beforeXP,
    afterXP,
    beforeLevel: beforeLevel || null,
    afterLevel: afterLevel || null,
    reason: options.reason || 'system',
    sourceId: options.sourceId || null,
    sourceType: options.sourceType || null,
    metadata: options.metadata || {}
  };

  const xpLog = (prisma as any).xpLog || (prisma as any).experienceLog || null;

  if (xpLog?.create) {
    await xpLog.create({ data }).catch(() => null);
  }
}

async function createLevelNotification(userId: string, level: string, xp: number) {
  const notification = (prisma as any).notification;

  if (notification?.create) {
    await notification.create({
      data: {
        userId,
        title: 'Level up',
        body: `You reached ${level}`,
        type: 'system',
        data: {
          event: 'level_up',
          level,
          xp
        }
      }
    }).catch(() => null);
  }
}

async function createXPNotification(userId: string, points: number, xp: number, reason?: string) {
  const notification = (prisma as any).notification;

  if (notification?.create) {
    await notification.create({
      data: {
        userId,
        title: points >= 0 ? 'XP earned' : 'XP updated',
        body: points >= 0 ? `You earned ${points} XP` : `Your XP changed by ${points}`,
        type: 'system',
        data: {
          event: 'xp_update',
          points,
          xp,
          reason: reason || 'system'
        }
      }
    }).catch(() => null);
  }
}

export async function addXP(userId: string, points: number, options: AddXPOptions = {}) {
  try {
    if (!userId || typeof userId !== 'string') return null;

    const rawPoints = normalizeNumber(points);
    if (!Number.isFinite(rawPoints) || rawPoints === 0) return null;
    if (rawPoints < 0 && !options.allowNegative) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        xp: true,
        level: true
      } as any
    });

    if (!user) return null;

    const beforeXP = normalizeNumber((user as any).xp);
    const beforeLevel = (user as any).level;
    const afterXP = clamp(beforeXP + rawPoints, 0);
    const nextLevel = getLevelConfigByXP(afterXP).level;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        xp: afterXP,
        level: nextLevel as any
      } as any
    });

    await createXPLog(userId, rawPoints, beforeXP, afterXP, beforeLevel, (updated as any).level, options);

    const levelChanged = String(beforeLevel || '').toUpperCase() !== String((updated as any).level || '').toUpperCase();

    if (options.notify !== false) {
      if (levelChanged) {
        await createLevelNotification(userId, String((updated as any).level), afterXP);
      } else if (rawPoints > 0 && rawPoints >= 10) {
        await createXPNotification(userId, rawPoints, afterXP, options.reason);
      }
    }

    if (options.emit !== false) {
      io.to(userId).emit('xp:update', {
        userId,
        xp: afterXP,
        points: rawPoints,
        level: (updated as any).level,
        reason: options.reason || 'system',
        progress: getProgress(afterXP, (updated as any).level)
      });

      if (levelChanged) {
        io.to(userId).emit('level:up', {
          userId,
          oldLevel: beforeLevel,
          newLevel: (updated as any).level,
          xp: afterXP,
          progress: getProgress(afterXP, (updated as any).level)
        });
      }
    }

    return updated;
  } catch (error) {
    console.error('XP update error:', error);
    return null;
  }
}

export async function setXP(userId: string, xp: number, options: AddXPOptions = {}) {
  try {
    if (!userId || typeof userId !== 'string') return null;

    const nextXP = clamp(normalizeNumber(xp), 0);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        xp: true,
        level: true
      } as any
    });

    if (!user) return null;

    const beforeXP = normalizeNumber((user as any).xp);
    const beforeLevel = (user as any).level;
    const nextLevel = getLevelConfigByXP(nextXP).level;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        xp: nextXP,
        level: nextLevel as any
      } as any
    });

    await createXPLog(userId, nextXP - beforeXP, beforeXP, nextXP, beforeLevel, (updated as any).level, {
      ...options,
      reason: options.reason || 'admin_adjustment',
      allowNegative: true
    });

    const levelChanged = String(beforeLevel || '').toUpperCase() !== String((updated as any).level || '').toUpperCase();

    if (options.emit !== false) {
      io.to(userId).emit('xp:update', {
        userId,
        xp: nextXP,
        points: nextXP - beforeXP,
        level: (updated as any).level,
        reason: options.reason || 'admin_adjustment',
        progress: getProgress(nextXP, (updated as any).level)
      });

      if (levelChanged) {
        io.to(userId).emit('level:up', {
          userId,
          oldLevel: beforeLevel,
          newLevel: (updated as any).level,
          xp: nextXP,
          progress: getProgress(nextXP, (updated as any).level)
        });
      }
    }

    return updated;
  } catch (error) {
    console.error('XP set error:', error);
    return null;
  }
}

export async function removeXP(userId: string, points: number, options: AddXPOptions = {}) {
  return addXP(userId, -Math.abs(normalizeNumber(points)), {
    ...options,
    allowNegative: true,
    reason: options.reason || 'admin_adjustment'
  });
}

export async function getXPProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      xp: true,
      level: true
    } as any
  });

  if (!user) return null;

  const xp = normalizeNumber((user as any).xp);
  const level = (user as any).level;
  const current = getLevelConfig(level);
  const next = getNextLevelConfig(level);

  return {
    ...user,
    xp,
    level,
    levelTitle: current.title,
    levelRank: current.rank,
    multiplier: current.multiplier,
    nextLevel: next?.level || null,
    nextLevelTitle: next?.title || null,
    progress: getProgress(xp, level)
  };
}

export async function addXPToMany(userIds: string[], points: number, options: AddXPOptions = {}) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const results: Array<{ userId: string; success: boolean; user: any | null }> = [];

  for (const userId of uniqueIds) {
    const user = await addXP(userId, points, {
      ...options,
      emit: options.emit ?? true,
      notify: options.notify ?? false
    });

    results.push({
      userId,
      success: !!user,
      user
    });
  }

  return results;
}

export async function getXPLeaderboard(limit = 50) {
  const take = clamp(Math.floor(normalizeNumber(limit, 50)), 1, 100);

  return prisma.user.findMany({
    where: {
      isBanned: false
    } as any,
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      xp: true,
      level: true
    } as any,
    orderBy: [
      { xp: 'desc' },
      { createdAt: 'asc' }
    ] as any,
    take
  }).catch(() => {
    return prisma.user.findMany({
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        isVerified: true,
        xp: true,
        level: true
      } as any,
      orderBy: {
        xp: 'desc'
      } as any,
      take
    });
  });
}

export function getLevelByXP(xp: number) {
  return getLevelConfigByXP(clamp(normalizeNumber(xp), 0));
}

export function getLevelProgress(xp: number, level?: LevelValue) {
  const safeXP = clamp(normalizeNumber(xp), 0);
  const safeLevel = level || getLevelConfigByXP(safeXP).level;
  return getProgress(safeXP, safeLevel);
}

export function getLevelTable() {
  return LEVELS.map(item => ({
    ...item
  }));
}
