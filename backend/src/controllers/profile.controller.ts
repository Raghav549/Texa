import { Request, Response } from 'express';
import crypto from 'crypto';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { prisma } from '../config/prisma';
import { generatePrestigeCard } from '../services/prestige.service';
import { io } from '../app';

type JsonObject = Record<string, any>;

const now = () => new Date();

const PROFILE_SELECT = {
  id: true,
  username: true,
  fullName: true,
  displayName: true,
  bio: true,
  bioLink: true,
  pronouns: true,
  avatarUrl: true,
  coverUrl: true,
  isVerified: true,
  isPrivate: true,
  followers: true,
  following: true,
  theme: true,
  accentColor: true,
  language: true,
  timezone: true,
  createdAt: true,
  updatedAt: true,
  email: true,
  phone: true,
  twoFactorEnabled: true,
  notificationSettings: true,
  privacySettings: true,
  safetySettings: true,
  displaySettings: true,
  profileBadges: {
    where: {
      isActive: true
    },
    orderBy: {
      earnedAt: 'desc'
    },
    select: {
      id: true,
      badgeKey: true,
      title: true,
      description: true,
      iconKey: true,
      tier: true,
      earnedAt: true
    }
  },
  stories: {
    where: {
      expiresAt: {
        gt: new Date()
      },
      archived: false,
      flagged: false
    },
    orderBy: {
      createdAt: 'desc'
    },
    select: {
      id: true,
      mediaUrl: true,
      mediaType: true,
      thumbnailUrl: true,
      caption: true,
      visibility: true,
      createdAt: true,
      expiresAt: true,
      viewers: true
    }
  },
  reels: {
    where: {
      isDraft: false,
      moderationStatus: 'approved',
      visibility: {
        in: ['public', 'followers']
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: 9,
    select: {
      id: true,
      videoUrl: true,
      thumbnailUrl: true,
      caption: true,
      views: true,
      likes: true,
      shares: true,
      createdAt: true,
      _count: {
        select: {
          comments: true
        }
      }
    }
  },
  _count: {
    select: {
      stories: true,
      reels: true
    }
  }
} as const;

const cleanString = (value: any, max = 160) => {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v) return '';
  return v.slice(0, max);
};

const normalizeUsername = (value: any) => {
  if (typeof value !== 'string') return undefined;
  const username = value.trim().toLowerCase().replace(/^@+/, '');
  if (!username) return undefined;
  if (!/^[a-z0-9._]{3,24}$/.test(username)) return null;
  if (username.includes('..') || username.startsWith('.') || username.endsWith('.')) return null;
  return username;
};

const isValidUrl = (value: any) => {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
};

const safeJson = (value: any, fallback: JsonObject = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return value;
};

const safeArray = (value: any) => {
  return Array.isArray(value) ? value.filter(Boolean) : [];
};

const safeEvidenceUrls = (value: any) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(isValidUrl).slice(0, 5);
};

const mergeJson = (base: any, patch: any) => {
  return {
    ...safeJson(base),
    ...safeJson(patch)
  };
};

const publicBadgeIcon = (tier?: string) => {
  const key = String(tier || '').toLowerCase();

  if (key === 'diamond') return 'prism-crown';
  if (key === 'platinum') return 'orbit-shield';
  if (key === 'gold') return 'solar-medal';
  if (key === 'silver') return 'lunar-ribbon';

  return 'nova-mark';
};

const getHeaderString = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
};

const getClientIp = (req: Request) => {
  const forwarded = getHeaderString(req.headers['x-forwarded-for']);
  if (forwarded) return forwarded.split(',')[0]?.trim() || req.ip || null;
  return req.ip || null;
};

const buildTrustProfile = (user: any, viewerId: string, userId: string) => {
  const followersCount = safeArray(user.followers).length;
  const followingCount = safeArray(user.following).length;
  const reelsCount = user._count?.reels || 0;
  const storiesCount = user._count?.stories || 0;
  const badgesCount = safeArray(user.profileBadges).length;
  const verifiedBoost = user.isVerified ? 25 : 0;

  const profileCompleteness = [
    user.username,
    user.fullName || user.displayName,
    user.bio,
    user.avatarUrl,
    user.bioLink,
    user.language,
    user.timezone
  ].filter(Boolean).length;

  const trustScore = Math.min(
    100,
    Math.round(
      verifiedBoost +
        Math.min(20, followersCount / 50) +
        Math.min(15, reelsCount * 2) +
        Math.min(10, storiesCount) +
        Math.min(15, badgesCount * 5) +
        Math.min(15, profileCompleteness * 2.2)
    )
  );

  return {
    trustScore,
    trustLevel:
      trustScore >= 90
        ? 'elite'
        : trustScore >= 75
          ? 'premium'
          : trustScore >= 55
            ? 'trusted'
            : trustScore >= 35
              ? 'rising'
              : 'new',
    followersCount,
    followingCount,
    reelsCount,
    storiesCount,
    badgesCount,
    isOwner: viewerId === userId
  };
};

const sanitizeProfile = (user: any, viewerId: string, userId: string, extras: JsonObject = {}) => {
  const isOwner = viewerId === userId;
  const privacy = safeJson(user.privacySettings);
  const isPrivate = Boolean(user.isPrivate || privacy.profileVisibility === 'private');
  const followers = safeArray(user.followers);
  const following = safeArray(user.following);
  const isFollowing = followers.includes(viewerId);
  const followsViewer = following.includes(viewerId);
  const isBlocked = Boolean(extras.isBlocked);
  const hasBlockedViewer = Boolean(extras.hasBlockedViewer);
  const canViewPrivate = !isBlocked && !hasBlockedViewer && (isOwner || isFollowing || !isPrivate);

  const badges = safeArray(user.profileBadges).map((badge: any) => ({
    ...badge,
    iconKey: badge.iconKey || publicBadgeIcon(badge.tier)
  }));

  const reels = canViewPrivate ? safeArray(user.reels) : [];

  const stories = canViewPrivate
    ? safeArray(user.stories).filter((story: any) => {
        if (story.visibility === 'all' || story.visibility === 'public') return true;
        if (story.visibility === 'followers') return isOwner || isFollowing;
        if (story.visibility === 'private') return isOwner;
        return isOwner;
      })
    : [];

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    displayName: user.displayName,
    bio: canViewPrivate ? user.bio : null,
    bioLink: canViewPrivate ? user.bioLink : null,
    pronouns: canViewPrivate ? user.pronouns : null,
    avatarUrl: user.avatarUrl,
    coverUrl: canViewPrivate ? user.coverUrl : null,
    isVerified: user.isVerified,
    isPrivate,
    theme: canViewPrivate ? user.theme : null,
    accentColor: canViewPrivate ? user.accentColor : null,
    language: canViewPrivate ? user.language : null,
    timezone: isOwner ? user.timezone : null,
    twoFactorEnabled: isOwner ? user.twoFactorEnabled : undefined,
    email: isOwner ? user.email : undefined,
    phone: isOwner ? user.phone : undefined,
    notificationSettings: isOwner ? user.notificationSettings : undefined,
    privacySettings: isOwner ? user.privacySettings : undefined,
    safetySettings: isOwner ? user.safetySettings : undefined,
    displaySettings: isOwner ? user.displaySettings : undefined,
    stories,
    reels,
    profileBadges: badges,
    social: {
      isFollowing,
      followsViewer,
      canViewPrivate,
      isBlocked,
      hasBlockedViewer,
      mutualFollowers: extras.mutualFollowers || []
    },
    prestige: buildTrustProfile(user, viewerId, userId),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

const createSecurityEvent = async (userId: string, type: string, req: Request, metadata: JsonObject = {}) => {
  try {
    await prisma.securityEvent.create({
      data: {
        userId,
        type,
        ip: getClientIp(req),
        userAgent: getHeaderString(req.headers['user-agent']),
        metadata
      }
    });
  } catch {}
};

const sendError = (res: Response, status: number, code: string, message: string) => {
  return res.status(status).json({
    success: false,
    error: message,
    code
  });
};

const sendSuccess = (res: Response, data: JsonObject = {}, status = 200) => {
  return res.status(status).json({
    success: true,
    ...data
  });
};

export const getFullProfile = async (req: Request, res: Response) => {
  try {
    const viewerId = req.userId!;
    const userId = req.params.id || viewerId;

    const [user, viewerBlock, targetBlock] = await Promise.all([
      prisma.user.findUnique({
        where: {
          id: userId
        },
        select: PROFILE_SELECT
      }),
      prisma.blockedUser.findFirst({
        where: {
          blockerId: viewerId,
          blockedId: userId
        }
      }),
      prisma.blockedUser.findFirst({
        where: {
          blockerId: userId,
          blockedId: viewerId
        }
      })
    ]);

    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');

    const mutualFollowers =
      viewerId !== userId
        ? await prisma.user.findMany({
            where: {
              id: {
                in: safeArray(user.followers).slice(0, 200)
              },
              followers: {
                has: viewerId
              }
            },
            select: {
              id: true,
              username: true,
              avatarUrl: true,
              isVerified: true
            },
            take: 6
          })
        : [];

    const profile = sanitizeProfile(user, viewerId, userId, {
      isBlocked: Boolean(viewerBlock),
      hasBlockedViewer: Boolean(targetBlock),
      mutualFollowers
    });

    return sendSuccess(res, {
      profile
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to load profile',
      code: 'PROFILE_LOAD_FAILED'
    });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const current = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        username: true
      }
    });

    if (!current) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');

    const username = normalizeUsername(req.body.username);

    if (username === null) {
      return sendError(
        res,
        400,
        'INVALID_USERNAME',
        'Username must be 3-24 characters and can contain letters, numbers, dot and underscore'
      );
    }

    if (username && username !== current.username?.toLowerCase()) {
      const exists = await prisma.user.findUnique({
        where: {
          username
        },
        select: {
          id: true
        }
      });

      if (exists && exists.id !== userId) {
        return sendError(res, 409, 'USERNAME_TAKEN', 'Username taken');
      }
    }

    const bioLink = req.body.bioLink === undefined ? undefined : cleanString(req.body.bioLink, 300);
    const avatarUrl = req.body.avatarUrl === undefined ? undefined : cleanString(req.body.avatarUrl, 500);
    const coverUrl = req.body.coverUrl === undefined ? undefined : cleanString(req.body.coverUrl, 500);

    if (bioLink && !isValidUrl(bioLink)) {
      return sendError(res, 400, 'INVALID_LINK', 'Bio link must be a valid http or https URL');
    }

    if (avatarUrl && !isValidUrl(avatarUrl)) {
      return sendError(res, 400, 'INVALID_AVATAR', 'Avatar URL is invalid');
    }

    if (coverUrl && !isValidUrl(coverUrl)) {
      return sendError(res, 400, 'INVALID_COVER', 'Cover URL is invalid');
    }

    const data: JsonObject = {
      fullName: req.body.fullName === undefined ? undefined : cleanString(req.body.fullName, 80),
      username: username || undefined,
      bio: req.body.bio === undefined ? undefined : cleanString(req.body.bio, 220),
      avatarUrl,
      coverUrl,
      displayName: req.body.displayName === undefined ? undefined : cleanString(req.body.displayName, 60),
      bioLink,
      pronouns: req.body.pronouns === undefined ? undefined : cleanString(req.body.pronouns, 40),
      theme: req.body.theme === undefined ? undefined : cleanString(req.body.theme, 40),
      accentColor: req.body.accentColor === undefined ? undefined : cleanString(req.body.accentColor, 40),
      language: req.body.language === undefined ? undefined : cleanString(req.body.language, 12),
      timezone: req.body.timezone === undefined ? undefined : cleanString(req.body.timezone, 80),
      updatedAt: now()
    };

    Object.keys(data).forEach((key) => {
      if (data[key] === undefined) delete data[key];
    });

    const updated = await prisma.user.update({
      where: {
        id: userId
      },
      data,
      select: PROFILE_SELECT
    });

    await createSecurityEvent(userId, 'profile_updated', req, {
      fields: Object.keys(data).filter((key) => key !== 'updatedAt')
    });

    io.to(`user:${userId}`).emit('profile:updated', {
      userId,
      username: updated.username,
      avatarUrl: updated.avatarUrl,
      updatedAt: updated.updatedAt
    });

    io.to('global').emit('profile:public_updated', {
      userId,
      username: updated.username,
      avatarUrl: updated.avatarUrl,
      displayName: updated.displayName,
      isVerified: updated.isVerified
    });

    return sendSuccess(res, {
      profile: sanitizeProfile(updated, userId, userId)
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to update profile',
      code: 'PROFILE_UPDATE_FAILED'
    });
  }
};

export const updateSettings = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const current = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        notificationSettings: true,
        privacySettings: true,
        safetySettings: true,
        displaySettings: true
      }
    });

    if (!current) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');

    const data: JsonObject = {};

    if (req.body.notifications !== undefined) {
      data.notificationSettings = mergeJson(current.notificationSettings, req.body.notifications);
    }

    if (req.body.privacy !== undefined) {
      data.privacySettings = mergeJson(current.privacySettings, req.body.privacy);
    }

    if (req.body.safety !== undefined) {
      data.safetySettings = mergeJson(current.safetySettings, req.body.safety);
    }

    if (req.body.display !== undefined) {
      data.displaySettings = mergeJson(current.displaySettings, req.body.display);
    }

    if (!Object.keys(data).length) {
      return sendError(res, 400, 'NO_SETTINGS', 'No settings provided');
    }

    data.updatedAt = now();

    const updated = await prisma.user.update({
      where: {
        id: userId
      },
      data,
      select: {
        notificationSettings: true,
        privacySettings: true,
        safetySettings: true,
        displaySettings: true
      }
    });

    await createSecurityEvent(userId, 'settings_updated', req, {
      groups: Object.keys(data).filter((key) => key !== 'updatedAt')
    });

    io.to(`user:${userId}`).emit('settings:updated', updated);

    return sendSuccess(res, {
      status: 'updated',
      settings: updated
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to update settings',
      code: 'SETTINGS_UPDATE_FAILED'
    });
  }
};

export const blockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.body;
    const userId = req.userId!;

    if (!targetId || typeof targetId !== 'string') {
      return sendError(res, 400, 'TARGET_REQUIRED', 'Target user required');
    }

    if (targetId === userId) {
      return sendError(res, 400, 'SELF_BLOCK_NOT_ALLOWED', 'You cannot block yourself');
    }

    const [target, user, targetUser] = await Promise.all([
      prisma.user.findUnique({
        where: {
          id: targetId
        },
        select: {
          id: true
        }
      }),
      prisma.user.findUnique({
        where: {
          id: userId
        },
        select: {
          following: true,
          followers: true
        }
      }),
      prisma.user.findUnique({
        where: {
          id: targetId
        },
        select: {
          following: true,
          followers: true
        }
      })
    ]);

    if (!target || !user || !targetUser) {
      return sendError(res, 404, 'TARGET_NOT_FOUND', 'Target user not found');
    }

    const nextUserFollowing = safeArray(user.following).filter((id) => id !== targetId);
    const nextUserFollowers = safeArray(user.followers).filter((id) => id !== targetId);
    const nextTargetFollowing = safeArray(targetUser.following).filter((id) => id !== userId);
    const nextTargetFollowers = safeArray(targetUser.followers).filter((id) => id !== userId);

    await prisma.$transaction([
      prisma.blockedUser.upsert({
        where: {
          blockerId_blockedId: {
            blockerId: userId,
            blockedId: targetId
          }
        },
        update: {
          updatedAt: now()
        },
        create: {
          blockerId: userId,
          blockedId: targetId
        }
      }),
      prisma.user.update({
        where: {
          id: userId
        },
        data: {
          following: {
            set: nextUserFollowing
          },
          followers: {
            set: nextUserFollowers
          }
        }
      }),
      prisma.user.update({
        where: {
          id: targetId
        },
        data: {
          following: {
            set: nextTargetFollowing
          },
          followers: {
            set: nextTargetFollowers
          }
        }
      })
    ]);

    await createSecurityEvent(userId, 'user_blocked', req, {
      targetId
    });

    io.to(`user:${targetId}`).emit('social:blocked_by_user', {
      userId
    });

    io.to(`user:${userId}`).emit('social:block_updated', {
      targetId,
      blocked: true
    });

    return sendSuccess(res, {
      status: 'blocked',
      targetId
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to block user',
      code: 'BLOCK_FAILED'
    });
  }
};

export const unblockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.body;
    const userId = req.userId!;

    if (!targetId || typeof targetId !== 'string') {
      return sendError(res, 400, 'TARGET_REQUIRED', 'Target user required');
    }

    await prisma.blockedUser.deleteMany({
      where: {
        blockerId: userId,
        blockedId: targetId
      }
    });

    await createSecurityEvent(userId, 'user_unblocked', req, {
      targetId
    });

    io.to(`user:${userId}`).emit('social:block_updated', {
      targetId,
      blocked: false
    });

    return sendSuccess(res, {
      status: 'unblocked',
      targetId
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to unblock user',
      code: 'UNBLOCK_FAILED'
    });
  }
};

export const reportUser = async (req: Request, res: Response) => {
  try {
    const { targetId, reason, details, evidenceUrls } = req.body;
    const userId = req.userId!;

    if (!targetId || typeof targetId !== 'string') {
      return sendError(res, 400, 'TARGET_REQUIRED', 'Target user required');
    }

    if (targetId === userId) {
      return sendError(res, 400, 'SELF_REPORT_NOT_ALLOWED', 'You cannot report yourself');
    }

    const cleanReason = cleanString(reason, 80);

    if (!cleanReason) {
      return sendError(res, 400, 'REASON_REQUIRED', 'Report reason required');
    }

    const target = await prisma.user.findUnique({
      where: {
        id: targetId
      },
      select: {
        id: true
      }
    });

    if (!target) {
      return sendError(res, 404, 'TARGET_NOT_FOUND', 'Target user not found');
    }

    const recent = await prisma.report.findFirst({
      where: {
        reporterId: userId,
        targetType: 'user',
        targetId,
        createdAt: {
          gt: new Date(Date.now() - 10 * 60 * 1000)
        }
      }
    });

    if (recent) {
      return sendError(res, 429, 'REPORT_RATE_LIMITED', 'You already reported this user recently');
    }

    const report = await prisma.report.create({
      data: {
        reporterId: userId,
        targetType: 'user',
        targetId,
        reason: cleanReason,
        details: cleanString(details, 1200) || null,
        evidenceUrls: safeEvidenceUrls(evidenceUrls)
      }
    });

    const reportCount = await prisma.report.count({
      where: {
        targetType: 'user',
        targetId,
        status: 'pending'
      }
    });

    if (reportCount >= 5) {
      io.to('admin:moderation').emit('user:flagged', {
        targetId,
        reportCount,
        latestReportId: report.id
      });
    }

    await createSecurityEvent(userId, 'user_reported', req, {
      targetId,
      reason: cleanReason
    });

    return sendSuccess(
      res,
      {
        status: 'reported',
        reportId: report.id
      },
      201
    );
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to report user',
      code: 'REPORT_FAILED'
    });
  }
};

export const enable2FA = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        username: true,
        email: true,
        twoFactorEnabled: true
      }
    });

    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');

    if (user.twoFactorEnabled) {
      return sendError(res, 400, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled');
    }

    const secret = speakeasy.generateSecret({
      name: `Texa:${user.username || user.email || userId}`,
      issuer: 'Texa',
      length: 32
    });

    const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
    const backupCodeHashes = backupCodes.map((code) => crypto.createHash('sha256').update(code).digest('hex'));
    const qrCode = await QRCode.toDataURL(secret.otpauth_url || '');

    await prisma.user.update({
      where: {
        id: userId
      },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: secret.base32,
        backupCodes: backupCodeHashes
      }
    });

    await createSecurityEvent(userId, 'two_factor_setup_started', req);

    return sendSuccess(res, {
      secret: secret.base32,
      qrCode,
      otpauthUrl: secret.otpauth_url,
      backupCodes,
      message: 'Scan QR and verify to enable'
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to start 2FA setup',
      code: 'TWO_FACTOR_SETUP_FAILED'
    });
  }
};

export const verify2FA = async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    const userId = req.userId!;

    if (!token || typeof token !== 'string') {
      return sendError(res, 400, 'TOKEN_REQUIRED', 'Verification token required');
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        twoFactorSecret: true,
        twoFactorEnabled: true
      }
    });

    if (!user?.twoFactorSecret) {
      return sendError(res, 400, 'TWO_FACTOR_NOT_STARTED', 'Start 2FA setup first');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: token.replace(/\s+/g, ''),
      window: 1
    });

    if (!isValid) {
      await createSecurityEvent(userId, 'two_factor_verify_failed', req);
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid token');
    }

    await prisma.user.update({
      where: {
        id: userId
      },
      data: {
        twoFactorEnabled: true,
        twoFactorVerifiedAt: now()
      }
    });

    await createSecurityEvent(userId, 'two_factor_enabled', req);

    io.to(`user:${userId}`).emit('security:two_factor_enabled', {
      enabled: true,
      enabledAt: now()
    });

    return sendSuccess(res, {
      status: 'enabled'
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to verify 2FA',
      code: 'TWO_FACTOR_VERIFY_FAILED'
    });
  }
};

export const disable2FA = async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        twoFactorSecret: true,
        twoFactorEnabled: true
      }
    });

    if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
      return sendError(res, 400, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: String(token || '').replace(/\s+/g, ''),
      window: 1
    });

    if (!isValid) {
      await createSecurityEvent(userId, 'two_factor_disable_failed', req);
      return sendError(res, 400, 'INVALID_TOKEN', 'Invalid token');
    }

    await prisma.user.update({
      where: {
        id: userId
      },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        backupCodes: []
      }
    });

    await createSecurityEvent(userId, 'two_factor_disabled', req);

    io.to(`user:${userId}`).emit('security:two_factor_disabled', {
      enabled: false,
      disabledAt: now()
    });

    return sendSuccess(res, {
      status: 'disabled'
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to disable 2FA',
      code: 'TWO_FACTOR_DISABLE_FAILED'
    });
  }
};

export const getDeviceSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const currentSessionId = getHeaderString(req.headers['x-session-id']);

    const sessions = await prisma.deviceSession.findMany({
      where: {
        userId
      },
      orderBy: {
        lastActive: 'desc'
      },
      select: {
        id: true,
        deviceName: true,
        deviceType: true,
        platform: true,
        browser: true,
        ip: true,
        location: true,
        lastActive: true,
        createdAt: true,
        revokedAt: true
      }
    });

    return sendSuccess(res, {
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: currentSessionId === session.id
      }))
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to load sessions',
      code: 'SESSIONS_LOAD_FAILED'
    });
  }
};

export const logoutDevice = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    const userId = req.userId!;

    if (!sessionId || typeof sessionId !== 'string') {
      return sendError(res, 400, 'SESSION_REQUIRED', 'Session ID required');
    }

    const session = await prisma.deviceSession.findFirst({
      where: {
        id: sessionId,
        userId
      }
    });

    if (!session) {
      return sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    }

    await prisma.deviceSession.delete({
      where: {
        id: sessionId
      }
    });

    await createSecurityEvent(userId, 'device_logged_out', req, {
      sessionId
    });

    io.to(`user:${userId}`).emit('security:device_logged_out', {
      sessionId,
      loggedOutAt: now()
    });

    return sendSuccess(res, {
      status: 'logged_out',
      sessionId
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to logout device',
      code: 'DEVICE_LOGOUT_FAILED'
    });
  }
};

export const logoutOtherDevices = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const currentSessionId = getHeaderString(req.headers['x-session-id']);

    const result = await prisma.deviceSession.deleteMany({
      where: {
        userId,
        ...(currentSessionId
          ? {
              id: {
                not: currentSessionId
              }
            }
          : {})
      }
    });

    await createSecurityEvent(userId, 'other_devices_logged_out', req, {
      count: result.count
    });

    io.to(`user:${userId}`).emit('security:other_devices_logged_out', {
      count: result.count,
      currentSessionId,
      loggedOutAt: now()
    });

    return sendSuccess(res, {
      status: 'logged_out',
      count: result.count
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to logout other devices',
      code: 'OTHER_DEVICES_LOGOUT_FAILED'
    });
  }
};

export const downloadPrestigeCard = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const card = await generatePrestigeCard(userId);

    await createSecurityEvent(userId, 'prestige_card_generated', req);

    return sendSuccess(res, {
      card: {
        ...card,
        iconSystem: {
          verified: 'prism-verified',
          elite: 'aura-crown',
          trusted: 'shield-pulse',
          creator: 'nova-spark',
          community: 'orbit-ring'
        }
      }
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to generate prestige card',
      code: 'PRESTIGE_CARD_FAILED'
    });
  }
};

export const getBlockedUsers = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const blocked = await prisma.blockedUser.findMany({
      where: {
        blockerId: userId
      },
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
            isVerified: true
          }
        }
      }
    });

    return sendSuccess(res, {
      blockedUsers: blocked.map((item) => ({
        id: item.id,
        blockedAt: item.createdAt,
        user: item.blocked
      }))
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to load blocked users',
      code: 'BLOCKED_USERS_LOAD_FAILED'
    });
  }
};

export const getSecurityEvents = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));

    const events = await prisma.securityEvent.findMany({
      where: {
        userId
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: limit,
      select: {
        id: true,
        type: true,
        ip: true,
        userAgent: true,
        metadata: true,
        createdAt: true
      }
    });

    return sendSuccess(res, {
      events
    });
  } catch {
    return res.status(500).json({
      success: false,
      error: 'Failed to load security events',
      code: 'SECURITY_EVENTS_LOAD_FAILED'
    });
  }
};
