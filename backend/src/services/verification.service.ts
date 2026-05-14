import { prisma } from '../config/db';
import { io } from '../app';

export type AutoVerifyResult = {
  verified: boolean;
  changed: boolean;
  reason: string;
  user?: any;
  score: number;
  requirements: {
    followers: boolean;
    notAlreadyVerified: boolean;
    notReservedAccount: boolean;
    profileComplete: boolean;
    publicProfile: boolean;
    safeAccount: boolean;
  };
};

export const KASHYAP_CHECK = {
  username: 'kashyap',
  fullName: 'Texa',
  protected: true,
  reason: 'platform_reserved_account'
};

const RESERVED_USERNAMES = new Set([
  'kashyap',
  'texa',
  'admin',
  'superadmin',
  'support',
  'help',
  'security',
  'official',
  'verified',
  'system',
  'root',
  'moderator'
]);

const MIN_FOLLOWERS_FOR_AUTO_VERIFY = Number(process.env.AUTO_VERIFY_MIN_FOLLOWERS || 1000);
const MIN_PROFILE_SCORE = Number(process.env.AUTO_VERIFY_MIN_PROFILE_SCORE || 65);

const normalize = (value: any) => String(value || '').trim().toLowerCase();

const toArray = <T = any>(value: any): T[] => Array.isArray(value) ? value : [];

const safeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function getFollowerCount(user: any) {
  if (Array.isArray(user?.followers)) return user.followers.length;
  if (typeof user?.followersCount === 'number') return user.followersCount;
  if (typeof user?._count?.followers === 'number') return user._count.followers;
  return 0;
}

function isReservedAccount(user: any) {
  return RESERVED_USERNAMES.has(normalize(user?.username));
}

function isProfilePublic(user: any) {
  if (typeof user?.isPrivate === 'boolean') return !user.isPrivate;
  if (typeof user?.private === 'boolean') return !user.private;
  if (typeof user?.visibility === 'string') return normalize(user.visibility) !== 'private';
  return true;
}

function calculateProfileScore(user: any) {
  let score = 0;

  if (normalize(user?.username)) score += 15;
  if (normalize(user?.fullName || user?.name)) score += 12;
  if (normalize(user?.bio).length >= 12) score += 12;
  if (normalize(user?.avatarUrl || user?.avatar || user?.profileImage)) score += 15;
  if (normalize(user?.email) && user?.emailVerified !== false) score += 10;
  if (normalize(user?.phone) && user?.phoneVerified !== false) score += 8;
  if (toArray(user?.posts || user?.reels || user?.stories).length >= 3) score += 8;
  if (safeNumber(user?.xp) >= 100) score += 6;
  if (safeNumber(user?.level) >= 2) score += 4;
  if (isProfilePublic(user)) score += 10;

  return Math.min(100, score);
}

async function getAccountRisk(userId: string) {
  const [reports, moderationReports, rejectedReels, flaggedStories, flaggedComments] = await Promise.all([
    (prisma as any).report?.count?.({
      where: {
        targetType: 'user',
        targetId: userId,
        status: 'actioned'
      }
    }).catch(() => 0) || 0,
    (prisma as any).moderationReport?.count?.({
      where: {
        targetId: userId,
        status: {
          in: ['actioned', 'rejected', 'ACTIONED', 'REJECTED']
        }
      }
    }).catch(() => 0) || 0,
    (prisma as any).reel?.count?.({
      where: {
        userId,
        OR: [
          { moderationStatus: 'rejected' },
          { flagged: true }
        ]
      }
    }).catch(() => 0) || 0,
    (prisma as any).story?.count?.({
      where: {
        userId,
        flagged: true
      }
    }).catch(() => 0) || 0,
    (prisma as any).comment?.count?.({
      where: {
        userId,
        moderationStatus: {
          in: ['rejected', 'REJECTED']
        }
      }
    }).catch(() => 0) || 0
  ]);

  const total = safeNumber(reports) + safeNumber(moderationReports) + safeNumber(rejectedReels) + safeNumber(flaggedStories) + safeNumber(flaggedComments);

  return {
    total,
    safe: total < 3,
    reports: safeNumber(reports),
    moderationReports: safeNumber(moderationReports),
    rejectedReels: safeNumber(rejectedReels),
    flaggedStories: safeNumber(flaggedStories),
    flaggedComments: safeNumber(flaggedComments)
  };
}

async function createVerificationNotification(userId: string) {
  await (prisma as any).notification?.create?.({
    data: {
      userId,
      title: 'You are verified',
      body: 'Your profile now has the official verified badge.',
      type: 'system',
      data: {
        event: 'auto_verify',
        badge: 'verified'
      }
    }
  }).catch(() => null);
}

async function createVerificationAudit(userId: string, result: AutoVerifyResult, actor = 'system') {
  const data = {
    userId,
    actor,
    action: result.changed ? 'auto_verified' : 'auto_verify_checked',
    reason: result.reason,
    score: result.score,
    requirements: result.requirements,
    metadata: {
      verified: result.verified,
      changed: result.changed
    }
  };

  const auditModel = (prisma as any).verificationAudit || (prisma as any).auditLog || null;

  if (auditModel?.create) {
    await auditModel.create({ data }).catch(() => null);
  }
}

async function updateUserVerified(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      isVerified: true,
      verifiedAt: new Date(),
      verificationType: 'auto',
      verificationBadge: 'blue'
    } as any
  }).catch(() => {
    return prisma.user.update({
      where: { id: userId },
      data: {
        isVerified: true
      }
    });
  });
}

function buildResult(user: any, risk: any, changed: boolean, reason: string): AutoVerifyResult {
  const followers = getFollowerCount(user);
  const profileScore = calculateProfileScore(user);

  return {
    verified: !!user?.isVerified || changed,
    changed,
    reason,
    user,
    score: profileScore,
    requirements: {
      followers: followers >= MIN_FOLLOWERS_FOR_AUTO_VERIFY,
      notAlreadyVerified: !user?.isVerified,
      notReservedAccount: !isReservedAccount(user),
      profileComplete: profileScore >= MIN_PROFILE_SCORE,
      publicProfile: isProfilePublic(user),
      safeAccount: !!risk?.safe
    }
  };
}

export async function checkAutoVerify(userId: string): Promise<AutoVerifyResult | null> {
  try {
    if (!userId || typeof userId !== 'string') return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            followers: true
          }
        } as any
      } as any
    }).catch(() => {
      return prisma.user.findUnique({
        where: { id: userId }
      });
    });

    if (!user) return null;

    const risk = await getAccountRisk(userId);
    const followers = getFollowerCount(user);
    const profileScore = calculateProfileScore(user);

    if (user.isVerified) {
      const result = buildResult(user, risk, false, 'already_verified');
      await createVerificationAudit(userId, result);
      return result;
    }

    if (isReservedAccount(user)) {
      const result = buildResult(user, risk, false, 'reserved_account');
      await createVerificationAudit(userId, result);
      return result;
    }

    if (followers < MIN_FOLLOWERS_FOR_AUTO_VERIFY) {
      const result = buildResult(user, risk, false, 'followers_requirement_not_met');
      await createVerificationAudit(userId, result);
      return result;
    }

    if (profileScore < MIN_PROFILE_SCORE) {
      const result = buildResult(user, risk, false, 'profile_quality_requirement_not_met');
      await createVerificationAudit(userId, result);
      return result;
    }

    if (!isProfilePublic(user)) {
      const result = buildResult(user, risk, false, 'private_profile_not_eligible');
      await createVerificationAudit(userId, result);
      return result;
    }

    if (!risk.safe) {
      const result = buildResult(user, risk, false, 'account_risk_too_high');
      await createVerificationAudit(userId, result);
      return result;
    }

    const updatedUser = await updateUserVerified(userId);
    const result = buildResult(updatedUser, risk, true, 'auto_verified');

    await Promise.all([
      createVerificationNotification(userId),
      createVerificationAudit(userId, result)
    ]);

    io.to(userId).emit('verify:success', {
      userId,
      isVerified: true,
      badge: 'blue',
      reason: result.reason
    });

    io.emit('user:verified', {
      userId,
      username: updatedUser.username,
      fullName: updatedUser.fullName,
      avatarUrl: (updatedUser as any).avatarUrl || (updatedUser as any).avatar,
      isVerified: true,
      badge: 'blue'
    });

    return result;
  } catch (error) {
    console.error('Auto verify error:', error);
    return null;
  }
}

export async function forceVerifyUser(userId: string, actorId?: string) {
  const user = await updateUserVerified(userId);

  const result: AutoVerifyResult = {
    verified: true,
    changed: true,
    reason: 'manual_force_verified',
    user,
    score: calculateProfileScore(user),
    requirements: {
      followers: true,
      notAlreadyVerified: true,
      notReservedAccount: true,
      profileComplete: true,
      publicProfile: true,
      safeAccount: true
    }
  };

  await Promise.all([
    createVerificationNotification(userId),
    createVerificationAudit(userId, result, actorId || 'admin')
  ]);

  io.to(userId).emit('verify:success', {
    userId,
    isVerified: true,
    badge: 'blue',
    reason: result.reason
  });

  io.emit('user:verified', {
    userId,
    username: user.username,
    fullName: user.fullName,
    avatarUrl: (user as any).avatarUrl || (user as any).avatar,
    isVerified: true,
    badge: 'blue'
  });

  return result;
}

export async function revokeVerification(userId: string, reason = 'verification_revoked', actorId?: string) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      isVerified: false,
      verifiedAt: null,
      verificationType: null,
      verificationBadge: null
    } as any
  }).catch(() => {
    return prisma.user.update({
      where: { id: userId },
      data: {
        isVerified: false
      }
    });
  });

  const result: AutoVerifyResult = {
    verified: false,
    changed: true,
    reason,
    user,
    score: calculateProfileScore(user),
    requirements: {
      followers: false,
      notAlreadyVerified: false,
      notReservedAccount: !isReservedAccount(user),
      profileComplete: false,
      publicProfile: isProfilePublic(user),
      safeAccount: true
    }
  };

  await createVerificationAudit(userId, result, actorId || 'admin');

  io.to(userId).emit('verify:revoked', {
    userId,
    isVerified: false,
    reason
  });

  io.emit('user:verification_revoked', {
    userId,
    username: user.username,
    isVerified: false
  });

  return result;
}
