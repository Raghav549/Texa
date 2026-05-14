import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { addXP, checkAutoVerify } from '../services/xp.service';
import { generatePrestigeData } from '../services/prestige.service';
import { uploadFile } from '../utils/upload';
import { io } from '../app';

const PROFILE_LIMIT = 20;
const PROFILE_MAX_LIMIT = 50;

const cleanText = (value: unknown, max = 500) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.slice(0, max);
};

const parseBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const parseLimit = (value: unknown, fallback = PROFILE_LIMIT) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), PROFILE_MAX_LIMIT);
};

const safeJson = <T = any>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

const sanitizeUser = (user: any, viewerId?: string) => {
  if (!user) return null;

  const followers = Array.isArray(user.followers) ? user.followers : [];
  const following = Array.isArray(user.following) ? user.following : [];
  const blockedUsers = Array.isArray(user.blockedUsers) ? user.blockedUsers : [];

  const {
    password,
    otp,
    otpExpiresAt,
    resetToken,
    resetTokenExpiresAt,
    refreshToken,
    twoFactorSecret,
    loginAttempts,
    internalNotes,
    ...safe
  } = user;

  return {
    ...safe,
    followersCount: followers.length,
    followingCount: following.length,
    isFollowing: viewerId ? followers.includes(viewerId) : false,
    isFollowedBy: viewerId ? following.includes(viewerId) : false,
    isBlockedByMe: viewerId ? blockedUsers.includes(viewerId) : false
  };
};

const getPublicUserInclude = () => ({
  _count: {
    select: {
      posts: true,
      reels: true,
      products: true,
      stories: true
    }
  }
});

const getUserByIdOrUsername = async (idOrUsername: string) => {
  return prisma.user.findFirst({
    where: {
      OR: [
        { id: idOrUsername },
        { username: idOrUsername }
      ]
    },
    include: getPublicUserInclude()
  });
};

export const getProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.userId;

    const user = await getUserByIdOrUsername(id);

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const blockedUsers = Array.isArray((user as any).blockedUsers) ? (user as any).blockedUsers : [];

    if (viewerId && blockedUsers.includes(viewerId)) {
      return res.status(403).json({
        error: 'Profile unavailable'
      });
    }

    res.json(sanitizeUser(user, viewerId));
  } catch {
    res.status(500).json({
      error: 'Failed to fetch profile'
    });
  }
};

export const getMe = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: getPublicUserInclude()
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json(sanitizeUser(user, userId));
  } catch {
    res.status(500).json({
      error: 'Failed to fetch account'
    });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const data: any = {};

    const fullName = cleanText(req.body.fullName, 80);
    const username = cleanText(req.body.username, 40)?.toLowerCase();
    const bio = cleanText(req.body.bio, 220);
    const website = cleanText(req.body.website, 180);
    const location = cleanText(req.body.location, 120);
    const gender = cleanText(req.body.gender, 30);
    const language = cleanText(req.body.language, 20);
    const timezone = cleanText(req.body.timezone, 80);

    if (fullName !== undefined) data.fullName = fullName;
    if (bio !== undefined) data.bio = bio;
    if (website !== undefined) data.website = website;
    if (location !== undefined) data.location = location;
    if (gender !== undefined) data.gender = gender;
    if (language !== undefined) data.language = language;
    if (timezone !== undefined) data.timezone = timezone;

    if (username) {
      if (!/^[a-z0-9._]{3,40}$/.test(username)) {
        return res.status(400).json({
          error: 'Username must be 3-40 characters and can contain letters, numbers, dot and underscore'
        });
      }

      const existing = await prisma.user.findFirst({
        where: {
          username,
          NOT: { id: userId }
        },
        select: { id: true }
      });

      if (existing) {
        return res.status(409).json({
          error: 'Username already taken'
        });
      }

      data.username = username;
    }

    if (req.body.preferences !== undefined) data.preferences = safeJson(req.body.preferences, {});
    if (req.body.socialLinks !== undefined) data.socialLinks = safeJson(req.body.socialLinks, {});
    if (req.body.privacySettings !== undefined) data.privacySettings = safeJson(req.body.privacySettings, {});
    if (req.body.notificationSettings !== undefined) data.notificationSettings = safeJson(req.body.notificationSettings, {});
    if (req.body.isPrivate !== undefined) data.isPrivate = parseBool(req.body.isPrivate);
    if (req.body.allowMessages !== undefined) data.allowMessages = parseBool(req.body.allowMessages, true);
    if (req.body.showActivityStatus !== undefined) data.showActivityStatus = parseBool(req.body.showActivityStatus, true);

    if (!Object.keys(data).length) {
      return res.status(400).json({
        error: 'No valid update fields provided'
      });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      include: getPublicUserInclude()
    });

    await addXP(userId, 2).catch(() => null);
    await checkAutoVerify(userId).catch(() => null);

    io.to(`user:${userId}`).emit('profile:updated', sanitizeUser(updated, userId));

    res.json(sanitizeUser(updated, userId));
  } catch {
    res.status(500).json({
      error: 'Failed to update profile'
    });
  }
};

export const uploadAvatar = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    if (!req.file) {
      return res.status(400).json({
        error: 'Avatar image required'
      });
    }

    const avatarUrl = await uploadFile(req.file, 'avatars');

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      include: getPublicUserInclude()
    });

    await addXP(userId, 2).catch(() => null);
    await checkAutoVerify(userId).catch(() => null);

    io.to(`user:${userId}`).emit('profile:avatar_updated', {
      userId,
      avatarUrl
    });

    res.json(sanitizeUser(updated, userId));
  } catch {
    res.status(500).json({
      error: 'Failed to upload avatar'
    });
  }
};

export const uploadCover = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    if (!req.file) {
      return res.status(400).json({
        error: 'Cover image required'
      });
    }

    const coverUrl = await uploadFile(req.file, 'covers');

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { coverUrl },
      include: getPublicUserInclude()
    });

    await addXP(userId, 2).catch(() => null);

    io.to(`user:${userId}`).emit('profile:cover_updated', {
      userId,
      coverUrl
    });

    res.json(sanitizeUser(updated, userId));
  } catch {
    res.status(500).json({
      error: 'Failed to upload cover'
    });
  }
};

export const follow = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const followerId = req.userId!;

    if (followerId === targetId) {
      return res.status(400).json({
        error: 'Cannot follow yourself'
      });
    }

    const [targetUser, currentUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          username: true,
          followers: true,
          blockedUsers: true,
          isPrivate: true
        }
      }),
      prisma.user.findUnique({
        where: { id: followerId },
        select: {
          id: true,
          username: true,
          following: true,
          blockedUsers: true
        }
      })
    ]);

    if (!targetUser || !currentUser) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const targetFollowers = Array.isArray(targetUser.followers) ? targetUser.followers : [];
    const currentFollowing = Array.isArray(currentUser.following) ? currentUser.following : [];
    const targetBlocked = Array.isArray((targetUser as any).blockedUsers) ? (targetUser as any).blockedUsers : [];
    const currentBlocked = Array.isArray((currentUser as any).blockedUsers) ? (currentUser as any).blockedUsers : [];

    if (targetBlocked.includes(followerId) || currentBlocked.includes(targetId)) {
      return res.status(403).json({
        error: 'Follow not allowed'
      });
    }

    if (targetFollowers.includes(followerId)) {
      return res.status(400).json({
        error: 'Already following'
      });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: targetId },
        data: {
          followers: Array.from(new Set([...targetFollowers, followerId]))
        }
      }),
      prisma.user.update({
        where: { id: followerId },
        data: {
          following: Array.from(new Set([...currentFollowing, targetId]))
        }
      })
    ]);

    await addXP(followerId, 1).catch(() => null);
    await checkAutoVerify(targetId).catch(() => null);

    io.to(`user:${targetId}`).emit('notification:follow', {
      type: 'follow',
      from: followerId,
      targetId,
      timestamp: new Date()
    });

    io.to(`user:${followerId}`).emit('profile:followed', {
      targetId
    });

    res.json({
      status: 'followed',
      targetId
    });
  } catch {
    res.status(500).json({
      error: 'Failed to follow user'
    });
  }
};

export const unfollow = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const followerId = req.userId!;

    if (followerId === targetId) {
      return res.status(400).json({
        error: 'Cannot unfollow yourself'
      });
    }

    const [targetUser, currentUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, followers: true }
      }),
      prisma.user.findUnique({
        where: { id: followerId },
        select: { id: true, following: true }
      })
    ]);

    if (!targetUser || !currentUser) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const targetFollowers = Array.isArray(targetUser.followers) ? targetUser.followers : [];
    const currentFollowing = Array.isArray(currentUser.following) ? currentUser.following : [];

    await prisma.$transaction([
      prisma.user.update({
        where: { id: targetId },
        data: {
          followers: targetFollowers.filter(id => id !== followerId)
        }
      }),
      prisma.user.update({
        where: { id: followerId },
        data: {
          following: currentFollowing.filter(id => id !== targetId)
        }
      })
    ]);

    io.to(`user:${followerId}`).emit('profile:unfollowed', {
      targetId
    });

    res.json({
      status: 'unfollowed',
      targetId
    });
  } catch {
    res.status(500).json({
      error: 'Failed to unfollow user'
    });
  }
};

export const blockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const userId = req.userId!;

    if (userId === targetId) {
      return res.status(400).json({
        error: 'Cannot block yourself'
      });
    }

    const [me, target] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          blockedUsers: true,
          following: true,
          followers: true
        }
      }),
      prisma.user.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          following: true,
          followers: true
        }
      })
    ]);

    if (!me || !target) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const myBlocked = Array.isArray((me as any).blockedUsers) ? (me as any).blockedUsers : [];
    const myFollowing = Array.isArray(me.following) ? me.following : [];
    const myFollowers = Array.isArray(me.followers) ? me.followers : [];
    const targetFollowing = Array.isArray(target.following) ? target.following : [];
    const targetFollowers = Array.isArray(target.followers) ? target.followers : [];

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          blockedUsers: Array.from(new Set([...myBlocked, targetId])),
          following: myFollowing.filter(id => id !== targetId),
          followers: myFollowers.filter(id => id !== targetId)
        } as any
      }),
      prisma.user.update({
        where: { id: targetId },
        data: {
          following: targetFollowing.filter(id => id !== userId),
          followers: targetFollowers.filter(id => id !== userId)
        }
      })
    ]);

    io.to(`user:${userId}`).emit('profile:blocked', {
      targetId
    });

    res.json({
      status: 'blocked',
      targetId
    });
  } catch {
    res.status(500).json({
      error: 'Failed to block user'
    });
  }
};

export const unblockUser = async (req: Request, res: Response) => {
  try {
    const { targetId } = req.params;
    const userId = req.userId!;

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        blockedUsers: true
      } as any
    });

    if (!me) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const blockedUsers = Array.isArray((me as any).blockedUsers) ? (me as any).blockedUsers : [];

    await prisma.user.update({
      where: { id: userId },
      data: {
        blockedUsers: blockedUsers.filter((id: string) => id !== targetId)
      } as any
    });

    io.to(`user:${userId}`).emit('profile:unblocked', {
      targetId
    });

    res.json({
      status: 'unblocked',
      targetId
    });
  } catch {
    res.status(500).json({
      error: 'Failed to unblock user'
    });
  }
};

export const searchUsers = async (req: Request, res: Response) => {
  try {
    const viewerId = req.userId;
    const q = cleanText(req.query.q, 80);
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    if (!q) {
      return res.json({
        users: [],
        nextCursor: null,
        hasMore: false
      });
    }

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
          { bio: { contains: q, mode: 'insensitive' } }
        ]
      },
      orderBy: [
        { isVerified: 'desc' },
        { followersCount: 'desc' as any },
        { createdAt: 'desc' }
      ],
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1,
      include: getPublicUserInclude()
    });

    const hasMore = users.length > limit;
    const result = hasMore ? users.slice(0, -1) : users;

    res.json({
      users: result.map(user => sanitizeUser(user, viewerId)),
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch {
    res.status(500).json({
      error: 'Failed to search users'
    });
  }
};

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.userId;
    const limit = parseLimit(req.query.limit);

    const user = await prisma.user.findUnique({
      where: { id },
      select: { followers: true }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const followerIds = Array.isArray(user.followers) ? user.followers.slice(0, limit) : [];

    const followers = await prisma.user.findMany({
      where: { id: { in: followerIds } },
      include: getPublicUserInclude()
    });

    const order = new Map(followerIds.map((uid, index) => [uid, index]));
    followers.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));

    res.json(followers.map(user => sanitizeUser(user, viewerId)));
  } catch {
    res.status(500).json({
      error: 'Failed to fetch followers'
    });
  }
};

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.userId;
    const limit = parseLimit(req.query.limit);

    const user = await prisma.user.findUnique({
      where: { id },
      select: { following: true }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const followingIds = Array.isArray(user.following) ? user.following.slice(0, limit) : [];

    const following = await prisma.user.findMany({
      where: { id: { in: followingIds } },
      include: getPublicUserInclude()
    });

    const order = new Map(followingIds.map((uid, index) => [uid, index]));
    following.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));

    res.json(following.map(user => sanitizeUser(user, viewerId)));
  } catch {
    res.status(500).json({
      error: 'Failed to fetch following'
    });
  }
};

export const getPrestige = async (req: Request, res: Response) => {
  try {
    const data = await generatePrestigeData(req.userId!);

    res.json(data);
  } catch (e: any) {
    res.status(400).json({
      error: e?.message || 'Failed to generate prestige data'
    });
  }
};

export const getProfileStats = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        followers: true,
        following: true,
        coins: true,
        xp: true,
        level: true,
        isVerified: true,
        createdAt: true,
        _count: {
          select: {
            posts: true,
            reels: true,
            stories: true,
            products: true
          }
        }
      } as any
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      userId: user.id,
      followers: Array.isArray(user.followers) ? user.followers.length : 0,
      following: Array.isArray(user.following) ? user.following.length : 0,
      posts: (user as any)._count?.posts || 0,
      reels: (user as any)._count?.reels || 0,
      stories: (user as any)._count?.stories || 0,
      products: (user as any)._count?.products || 0,
      coins: user.coins,
      xp: user.xp,
      level: (user as any).level || null,
      isVerified: user.isVerified,
      joinedAt: user.createdAt
    });
  } catch {
    res.status(500).json({
      error: 'Failed to fetch profile stats'
    });
  }
};
