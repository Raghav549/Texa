import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt, { SignOptions } from 'jsonwebtoken';
import { Prisma, UserRole } from '@prisma/client';
import { prisma, withTransaction } from '../config/db';
import { io } from '../server';

type AdminAction = 'delete' | 'verify' | 'unverify' | 'ban' | 'unban' | 'promote_admin' | 'demote_user';
type ReportAction = 'resolve' | 'reject' | 'review' | 'delete_target';
type ContentType = 'reel' | 'story' | 'comment' | 'room' | 'store' | 'product' | 'message';
type ContentAction = 'delete' | 'hide' | 'restore' | 'suspend' | 'activate';

const isProduction = process.env.NODE_ENV === 'production';

const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPERADMIN];

const normalizeEmail = (email: unknown) => String(email || '').trim().toLowerCase();

const normalizeString = (value: unknown) => String(value || '').trim();

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toSafeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT secret missing');
  return secret;
};

const generateAdminToken = (userId: string, role: UserRole) => {
  const options: SignOptions = {
    expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-admin'
  };

  return jwt.sign({ userId, role, scope: 'admin' }, getJwtSecret(), options);
};

const safeAdminUserSelect = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  phone: true,
  role: true,
  avatarUrl: true,
  coverUrl: true,
  isVerified: true,
  isBanned: true,
  banReason: true,
  coins: true,
  xp: true,
  level: true,
  trustScore: true,
  loginStreak: true,
  lastLogin: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

const sendError = (res: Response, status: number, error: string, code?: string, details?: unknown) => {
  return res.status(status).json({
    success: false,
    ok: false,
    error,
    code: code || error.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    ...(details === undefined ? {} : { details })
  });
};

const sendSuccess = (res: Response, status: number, data: Record<string, unknown>) => {
  return res.status(status).json({
    success: true,
    ok: true,
    ...data
  });
};

const logAdminError = (label: string, error: unknown) => {
  console.error(
    JSON.stringify(
      {
        level: 'error',
        label,
        message: error instanceof Error ? error.message : String(error),
        stack: isProduction || !(error instanceof Error) ? undefined : error.stack,
        timestamp: new Date().toISOString()
      },
      null,
      2
    )
  );
};

const emitAdminEvent = (event: string, payload: Record<string, unknown>) => {
  try {
    io.to('admin').emit(event, {
      ...payload,
      timestamp: new Date().toISOString()
    });
    io.to('global').emit(event, {
      ...payload,
      timestamp: new Date().toISOString()
    });
  } catch {}
};

export const adminLogin = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required', 'ADMIN_LOGIN_REQUIRED');
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !adminRoles.includes(user.role)) {
      return sendError(res, 403, 'Unauthorized access', 'ADMIN_UNAUTHORIZED');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Admin account is banned', 'ADMIN_BANNED');
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return sendError(res, 401, 'Invalid admin credentials', 'ADMIN_INVALID_CREDENTIALS');
    }

    const token = generateAdminToken(user.id, user.role);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: new Date(),
        loginStreak: { increment: 1 }
      }
    });

    emitAdminEvent('admin:login', {
      userId: user.id,
      role: user.role
    });

    return sendSuccess(res, 200, {
      token,
      admin: {
        id: user.id,
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    logAdminError('ADMIN_LOGIN_FAILED', error);
    return sendError(res, 500, 'Admin login failed', 'ADMIN_LOGIN_FAILED');
  }
};

export const listUsers = async (req: Request, res: Response) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(toPositiveInt(req.query.limit, 25), 100);
    const skip = (page - 1) * limit;
    const search = normalizeString(req.query.search);
    const role = normalizeString(req.query.role).toUpperCase();
    const status = normalizeString(req.query.status).toLowerCase();

    const where: Prisma.UserWhereInput = {
      ...(search
        ? {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { fullName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {}),
      ...(role && Object.values(UserRole).includes(role as UserRole) ? { role: role as UserRole } : {}),
      ...(status === 'verified' ? { isVerified: true } : {}),
      ...(status === 'unverified' ? { isVerified: false } : {}),
      ...(status === 'banned' ? { isBanned: true } : {}),
      ...(status === 'active' ? { isBanned: false } : {})
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          coverUrl: true,
          coins: true,
          xp: true,
          level: true,
          trustScore: true,
          isVerified: true,
          isBanned: true,
          banReason: true,
          role: true,
          followers: true,
          following: true,
          loginStreak: true,
          lastLogin: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      prisma.user.count({ where })
    ]);

    return sendSuccess(res, 200, {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logAdminError('LIST_USERS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch users', 'LIST_USERS_FAILED');
  }
};

export const manageUser = async (req: Request, res: Response) => {
  try {
    const userId = normalizeString(req.body?.userId);
    const action = normalizeString(req.body?.action).toLowerCase() as AdminAction;
    const reason = normalizeString(req.body?.reason);

    if (!userId || !action) {
      return sendError(res, 400, 'User ID and action are required', 'USER_ACTION_REQUIRED');
    }

    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: safeAdminUserSelect
    });

    if (!existingUser) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (existingUser.role === UserRole.SUPERADMIN && ['delete', 'ban', 'demote_user'].includes(action)) {
      return sendError(res, 403, 'Super admin cannot be modified by this action', 'SUPERADMIN_PROTECTED');
    }

    let result: unknown = null;

    if (action === 'delete') {
      result = await prisma.user.delete({
        where: { id: userId },
        select: { id: true }
      });
    } else if (action === 'verify') {
      result = await prisma.user.update({
        where: { id: userId },
        data: { isVerified: true },
        select: safeAdminUserSelect
      });
    } else if (action === 'unverify') {
      result = await prisma.user.update({
        where: { id: userId },
        data: { isVerified: false },
        select: safeAdminUserSelect
      });
    } else if (action === 'ban') {
      result = await prisma.user.update({
        where: { id: userId },
        data: {
          isBanned: true,
          banReason: reason || 'Admin action'
        },
        select: safeAdminUserSelect
      });
    } else if (action === 'unban') {
      result = await prisma.user.update({
        where: { id: userId },
        data: {
          isBanned: false,
          banReason: null
        },
        select: safeAdminUserSelect
      });
    } else if (action === 'promote_admin') {
      result = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.ADMIN },
        select: safeAdminUserSelect
      });
    } else if (action === 'demote_user') {
      result = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.USER },
        select: safeAdminUserSelect
      });
    } else {
      return sendError(res, 400, 'Invalid user action', 'INVALID_USER_ACTION');
    }

    emitAdminEvent('admin:userUpdated', {
      userId,
      action,
      reason: reason || null
    });

    io.to(`user:${userId}`).emit('user:adminUpdated', {
      action,
      reason: reason || null,
      timestamp: new Date().toISOString()
    });

    return sendSuccess(res, 200, {
      status: 'updated',
      action,
      user: result
    });
  } catch (error) {
    logAdminError('MANAGE_USER_FAILED', error);
    return sendError(res, 500, 'Failed to manage user', 'MANAGE_USER_FAILED');
  }
};

export const toggleVerify = async (req: Request, res: Response) => {
  try {
    const userId = normalizeString(req.body?.userId);
    const verify = req.body?.verify;

    if (!userId || typeof verify !== 'boolean') {
      return sendError(res, 400, 'Invalid verification request', 'INVALID_VERIFY_REQUEST');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { isVerified: verify },
      select: {
        id: true,
        username: true,
        fullName: true,
        isVerified: true,
        updatedAt: true
      }
    });

    emitAdminEvent('admin:verifyUpdated', {
      userId,
      verify
    });

    io.to(`user:${userId}`).emit('user:verificationUpdated', {
      verify,
      timestamp: new Date().toISOString()
    });

    return sendSuccess(res, 200, {
      status: verify ? 'verified' : 'unverified',
      user: updatedUser
    });
  } catch (error) {
    logAdminError('TOGGLE_VERIFY_FAILED', error);
    return sendError(res, 500, 'Failed to update verification', 'TOGGLE_VERIFY_FAILED');
  }
};

export const resetUserPass = async (req: Request, res: Response) => {
  try {
    const userId = normalizeString(req.body?.userId);
    const newPass = String(req.body?.newPass || '');

    if (!userId || !newPass) {
      return sendError(res, 400, 'User ID and new password are required', 'PASSWORD_RESET_REQUIRED');
    }

    if (newPass.length < 8) {
      return sendError(res, 400, 'Password must be at least 8 characters', 'WEAK_PASSWORD');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true }
    });

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (user.role === UserRole.SUPERADMIN) {
      return sendError(res, 403, 'Super admin password cannot be reset here', 'SUPERADMIN_PROTECTED');
    }

    const hashedPassword = await bcrypt.hash(newPass, Number(process.env.BCRYPT_ROUNDS || 12));

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        backupCodes: []
      }
    });

    emitAdminEvent('admin:passwordReset', {
      userId
    });

    io.to(`user:${userId}`).emit('user:passwordReset', {
      timestamp: new Date().toISOString()
    });

    return sendSuccess(res, 200, {
      status: 'password_reset'
    });
  } catch (error) {
    logAdminError('RESET_USER_PASSWORD_FAILED', error);
    return sendError(res, 500, 'Failed to reset password', 'RESET_USER_PASSWORD_FAILED');
  }
};

export const manageCoinsXP = async (req: Request, res: Response) => {
  try {
    const userId = normalizeString(req.body?.userId);
    const coins = req.body?.coins;
    const xp = req.body?.xp;
    const mode = normalizeString(req.body?.mode || 'set').toLowerCase();
    const source = normalizeString(req.body?.source || 'admin');
    const reason = normalizeString(req.body?.reason || 'Admin adjustment');

    if (!userId) {
      return sendError(res, 400, 'User ID required', 'USER_ID_REQUIRED');
    }

    if (coins === undefined && xp === undefined) {
      return sendError(res, 400, 'Coins or XP value required', 'COINS_XP_REQUIRED');
    }

    const updatedUser = await withTransaction(async tx => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, coins: true, xp: true }
      });

      if (!user) {
        throw Object.assign(new Error('User not found'), { status: 404, code: 'USER_NOT_FOUND' });
      }

      const coinValue = coins === undefined ? undefined : Math.trunc(toSafeNumber(coins));
      const xpValue = xp === undefined ? undefined : Math.trunc(toSafeNumber(xp));

      const nextCoins =
        coinValue === undefined
          ? user.coins
          : mode === 'increment'
            ? user.coins + coinValue
            : mode === 'decrement'
              ? user.coins - coinValue
              : coinValue;

      const nextXp =
        xpValue === undefined
          ? user.xp
          : mode === 'increment'
            ? user.xp + xpValue
            : mode === 'decrement'
              ? user.xp - xpValue
              : xpValue;

      const safeCoins = Math.max(0, nextCoins);
      const safeXp = Math.max(0, nextXp);

      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          coins: safeCoins,
          xp: safeXp
        },
        select: {
          id: true,
          coins: true,
          xp: true,
          level: true,
          updatedAt: true
        }
      });

      if (coinValue !== undefined) {
        await tx.coinTransaction.create({
          data: {
            userId,
            type: mode === 'decrement' ? 'DEBIT' : 'CREDIT',
            status: 'SUCCESS',
            amount: Math.abs(coinValue),
            balance: safeCoins,
            source,
            metadata: {
              reason,
              mode,
              previousCoins: user.coins,
              nextCoins: safeCoins
            }
          }
        });
      }

      return updated;
    });

    emitAdminEvent('admin:coinsXpUpdated', {
      userId,
      mode,
      coins: updatedUser.coins,
      xp: updatedUser.xp
    });

    io.to(`user:${userId}`).emit('user:walletUpdated', {
      coins: updatedUser.coins,
      xp: updatedUser.xp,
      timestamp: new Date().toISOString()
    });

    return sendSuccess(res, 200, {
      status: 'updated',
      user: updatedUser
    });
  } catch (error: any) {
    logAdminError('MANAGE_COINS_XP_FAILED', error);
    return sendError(res, Number(error?.status) || 500, error?.message || 'Failed to update coins/xp', error?.code || 'MANAGE_COINS_XP_FAILED');
  }
};

export const manageReports = async (req: Request, res: Response) => {
  try {
    const reportId = normalizeString(req.body?.reportId);
    const action = normalizeString(req.body?.action).toLowerCase() as ReportAction;
    const note = normalizeString(req.body?.note);

    if (!reportId || !action) {
      return sendError(res, 400, 'Report ID and action required', 'REPORT_ACTION_REQUIRED');
    }

    const report = await prisma.report.findUnique({
      where: { id: reportId }
    });

    if (!report) {
      return sendError(res, 404, 'Report not found', 'REPORT_NOT_FOUND');
    }

    let status = report.status;

    if (action === 'resolve') status = 'RESOLVED';
    else if (action === 'reject') status = 'REJECTED';
    else if (action === 'review') status = 'REVIEW';
    else if (action === 'delete_target') status = 'TARGET_DELETED';
    else return sendError(res, 400, 'Invalid report action', 'INVALID_REPORT_ACTION');

    const updatedReport = await prisma.report.update({
      where: { id: reportId },
      data: {
        status,
        details: note ? `${report.details || ''}${report.details ? '\n' : ''}${note}` : report.details
      }
    });

    emitAdminEvent('admin:reportUpdated', {
      reportId,
      action,
      status
    });

    return sendSuccess(res, 200, {
      status: 'handled',
      report: updatedReport
    });
  } catch (error) {
    logAdminError('MANAGE_REPORTS_FAILED', error);
    return sendError(res, 500, 'Failed to manage reports', 'MANAGE_REPORTS_FAILED');
  }
};

export const manageContent = async (req: Request, res: Response) => {
  try {
    const type = normalizeString(req.body?.type).toLowerCase() as ContentType;
    const id = normalizeString(req.body?.id);
    const action = normalizeString(req.body?.action || 'delete').toLowerCase() as ContentAction;
    const reason = normalizeString(req.body?.reason);

    if (!type || !id) {
      return sendError(res, 400, 'Content type and ID required', 'CONTENT_ACTION_REQUIRED');
    }

    let result: unknown = null;

    if (type === 'reel') {
      if (action === 'delete') {
        result = await prisma.reel.delete({ where: { id } });
      } else if (action === 'hide' || action === 'suspend') {
        result = await prisma.reel.update({
          where: { id },
          data: {
            moderationStatus: 'BLOCKED',
            flaggedReason: reason || 'Admin action'
          }
        });
      } else if (action === 'restore' || action === 'activate') {
        result = await prisma.reel.update({
          where: { id },
          data: {
            moderationStatus: 'SAFE',
            flaggedReason: null
          }
        });
      } else {
        return sendError(res, 400, 'Invalid content action', 'INVALID_CONTENT_ACTION');
      }
    } else if (type === 'story') {
      if (action === 'delete') {
        result = await prisma.story.delete({ where: { id } });
      } else if (action === 'hide' || action === 'suspend') {
        result = await prisma.story.update({
          where: { id },
          data: {
            moderationStatus: 'BLOCKED',
            flagged: true
          }
        });
      } else if (action === 'restore' || action === 'activate') {
        result = await prisma.story.update({
          where: { id },
          data: {
            moderationStatus: 'SAFE',
            flagged: false
          }
        });
      } else {
        return sendError(res, 400, 'Invalid content action', 'INVALID_CONTENT_ACTION');
      }
    } else if (type === 'comment') {
      if (action === 'delete') {
        result = await prisma.comment.delete({ where: { id } });
      } else if (action === 'hide' || action === 'suspend') {
        result = await prisma.comment.update({
          where: { id },
          data: {
            moderationStatus: 'BLOCKED'
          }
        });
      } else if (action === 'restore' || action === 'activate') {
        result = await prisma.comment.update({
          where: { id },
          data: {
            moderationStatus: 'SAFE'
          }
        });
      } else {
        return sendError(res, 400, 'Invalid content action', 'INVALID_CONTENT_ACTION');
      }
    } else if (type === 'room') {
      result = await prisma.voiceRoom.update({
        where: { id },
        data: {
          isActive: action === 'restore' || action === 'activate',
          status: action === 'restore' || action === 'activate' ? 'LIVE' : 'SUSPENDED',
          endedAt: action === 'restore' || action === 'activate' ? null : new Date()
        }
      });
    } else if (type === 'store') {
      result = await prisma.store.update({
        where: { id },
        data: {
          isVerified: action === 'restore' || action === 'activate'
        }
      });
    } else if (type === 'product') {
      result = await prisma.product.update({
        where: { id },
        data: {
          status: action === 'restore' || action === 'activate' ? 'ACTIVE' : action === 'delete' ? 'ARCHIVED' : 'ARCHIVED'
        }
      });
    } else if (type === 'message') {
      result = await prisma.message.update({
        where: { id },
        data: {
          deletedAt: action === 'restore' || action === 'activate' ? null : new Date()
        }
      });
    } else {
      return sendError(res, 400, 'Invalid content type', 'INVALID_CONTENT_TYPE');
    }

    emitAdminEvent('admin:contentManaged', {
      type,
      id,
      action,
      reason: reason || null
    });

    return sendSuccess(res, 200, {
      status: 'content_managed',
      type,
      action,
      content: result
    });
  } catch (error) {
    logAdminError('MANAGE_CONTENT_FAILED', error);
    return sendError(res, 500, 'Failed to manage content', 'MANAGE_CONTENT_FAILED');
  }
};

export const setAnnouncement = async (req: Request, res: Response) => {
  try {
    const title = normalizeString(req.body?.title);
    const content = normalizeString(req.body?.content);
    const priority = normalizeString(req.body?.priority || 'normal');
    const audience = normalizeString(req.body?.audience || 'all');

    if (!title || !content) {
      return sendError(res, 400, 'Title and content required', 'ANNOUNCEMENT_REQUIRED');
    }

    const announcement = {
      id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      title,
      content,
      priority,
      audience,
      isActive: true,
      createdAt: new Date().toISOString()
    };

    emitAdminEvent('announcement:new', announcement);

    return sendSuccess(res, 201, {
      announcement
    });
  } catch (error) {
    logAdminError('SET_ANNOUNCEMENT_FAILED', error);
    return sendError(res, 500, 'Failed to create announcement', 'SET_ANNOUNCEMENT_FAILED');
  }
};

export const getAnalytics = async (_req: Request, res: Response) => {
  try {
    const [
      totalUsers,
      verifiedUsers,
      bannedUsers,
      admins,
      activeRooms,
      totalRooms,
      totalReels,
      safeReels,
      reviewReels,
      blockedReels,
      totalStories,
      totalStores,
      verifiedStores,
      totalProducts,
      activeProducts,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      pendingReports,
      totalReports,
      totalComments,
      totalTransactions
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isVerified: true } }),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { role: { in: [UserRole.ADMIN, UserRole.SUPERADMIN] } } }),
      prisma.voiceRoom.count({ where: { isActive: true } }),
      prisma.voiceRoom.count(),
      prisma.reel.count(),
      prisma.reel.count({ where: { moderationStatus: 'SAFE' } }),
      prisma.reel.count({ where: { moderationStatus: 'REVIEW' } }),
      prisma.reel.count({ where: { moderationStatus: 'BLOCKED' } }),
      prisma.story.count(),
      prisma.store.count(),
      prisma.store.count({ where: { isVerified: true } }),
      prisma.product.count(),
      prisma.product.count({ where: { status: 'ACTIVE' } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: 'PENDING' } }),
      prisma.order.count({ where: { status: 'DELIVERED' } }),
      prisma.report.count({ where: { status: { in: ['pending', 'PENDING', 'REVIEW'] } } }),
      prisma.report.count(),
      prisma.comment.count(),
      prisma.coinTransaction.count()
    ]);

    const [latestUsers, latestReports, latestOrders, latestReels] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: safeAdminUserSelect
      }),
      prisma.report.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8
      }),
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          total: true,
          currency: true,
          buyerId: true,
          storeId: true,
          createdAt: true
        }
      }),
      prisma.reel.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          userId: true,
          caption: true,
          thumbnailUrl: true,
          views: true,
          shares: true,
          moderationStatus: true,
          createdAt: true
        }
      })
    ]);

    return sendSuccess(res, 200, {
      analytics: {
        users: {
          total: totalUsers,
          verified: verifiedUsers,
          banned: bannedUsers,
          admins
        },
        rooms: {
          total: totalRooms,
          active: activeRooms
        },
        reels: {
          total: totalReels,
          safe: safeReels,
          review: reviewReels,
          blocked: blockedReels
        },
        stories: {
          total: totalStories
        },
        commerce: {
          stores: totalStores,
          verifiedStores,
          products: totalProducts,
          activeProducts,
          orders: totalOrders,
          pendingOrders,
          deliveredOrders
        },
        moderation: {
          reports: totalReports,
          pendingReports,
          comments: totalComments
        },
        economy: {
          transactions: totalTransactions
        }
      },
      latest: {
        users: latestUsers,
        reports: latestReports,
        orders: latestOrders,
        reels: latestReels
      }
    });
  } catch (error) {
    logAdminError('GET_ANALYTICS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch analytics', 'GET_ANALYTICS_FAILED');
  }
};

export const listReports = async (req: Request, res: Response) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(toPositiveInt(req.query.limit, 25), 100);
    const skip = (page - 1) * limit;
    const status = normalizeString(req.query.status);

    const where: Prisma.ReportWhereInput = status ? { status } : {};

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          reporter: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true,
              role: true
            }
          }
        }
      }),
      prisma.report.count({ where })
    ]);

    return sendSuccess(res, 200, {
      reports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logAdminError('LIST_REPORTS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch reports', 'LIST_REPORTS_FAILED');
  }
};

export const listStores = async (req: Request, res: Response) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(toPositiveInt(req.query.limit, 25), 100);
    const skip = (page - 1) * limit;
    const search = normalizeString(req.query.search);

    const where: Prisma.StoreWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {};

    const [stores, total] = await Promise.all([
      prisma.store.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true,
              isVerified: true
            }
          },
          _count: {
            select: {
              products: true,
              orders: true,
              reviews: true
            }
          }
        }
      }),
      prisma.store.count({ where })
    ]);

    return sendSuccess(res, 200, {
      stores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logAdminError('LIST_STORES_FAILED', error);
    return sendError(res, 500, 'Failed to fetch stores', 'LIST_STORES_FAILED');
  }
};

export const listOrders = async (req: Request, res: Response) => {
  try {
    const page = toPositiveInt(req.query.page, 1);
    const limit = Math.min(toPositiveInt(req.query.limit, 25), 100);
    const skip = (page - 1) * limit;
    const status = normalizeString(req.query.status).toUpperCase();

    const where: Prisma.OrderWhereInput = status ? { status: status as any } : {};

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          buyer: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true
            }
          },
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true
            }
          },
          items: true
        }
      }),
      prisma.order.count({ where })
    ]);

    return sendSuccess(res, 200, {
      orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    logAdminError('LIST_ORDERS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch orders', 'LIST_ORDERS_FAILED');
  }
};

export const getAdminDashboard = async (req: Request, res: Response) => {
  return getAnalytics(req, res);
};
