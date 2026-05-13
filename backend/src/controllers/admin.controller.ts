import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {
  ModerationStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ProductStatus,
  RoomStatus,
  TransactionStatus,
  TransactionType,
  UserRole,
  WalletSource
} from '@prisma/client';
import { prisma, withTransaction } from '../config/db';
import { io } from '../server';

type AdminAction =
  | 'delete'
  | 'verify'
  | 'unverify'
  | 'ban'
  | 'unban'
  | 'promote_admin'
  | 'promote_creator'
  | 'demote_user';

type ReportAction = 'resolve' | 'reject' | 'review' | 'delete_target';

type ContentType =
  | 'reel'
  | 'story'
  | 'comment'
  | 'room'
  | 'store'
  | 'product'
  | 'message'
  | 'moderation_report';

type ContentAction =
  | 'delete'
  | 'hide'
  | 'restore'
  | 'suspend'
  | 'activate'
  | 'block'
  | 'review'
  | 'safe'
  | 'archive'
  | 'verify'
  | 'unverify';

type WalletMode = 'set' | 'increment' | 'decrement';

const isProd = process.env.NODE_ENV === 'production';

const adminUserSelect = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  phone: true,
  avatarUrl: true,
  role: true,
  isVerified: true,
  isBanned: true,
  banReason: true,
  coins: true,
  xp: true,
  level: true,
  trustScore: true,
  twoFactorEnabled: true,
  lastLogin: true,
  loginStreak: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

const publicUserSelect = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  phone: true,
  avatarUrl: true,
  coverUrl: true,
  role: true,
  coins: true,
  xp: true,
  level: true,
  trustScore: true,
  isVerified: true,
  isBanned: true,
  banReason: true,
  followers: true,
  following: true,
  createdAt: true,
  updatedAt: true,
  lastLogin: true
} satisfies Prisma.UserSelect;

const toInt = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const clampPagination = (req: Request) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 25)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const normalizeText = (value: unknown) => String(value ?? '').trim();

const normalizeEmail = (value: unknown) => normalizeText(value).toLowerCase();

const sendSuccess = (res: Response, status: number, data: Record<string, unknown> = {}) => {
  return res.status(status).json({
    success: true,
    ok: true,
    ...data
  });
};

const sendError = (
  res: Response,
  status: number,
  error: string,
  code = 'REQUEST_FAILED',
  extra: Record<string, unknown> = {}
) => {
  return res.status(status).json({
    success: false,
    ok: false,
    error,
    code,
    ...extra
  });
};

const logError = (label: string, error: unknown) => {
  const err = error as Error;
  console.error(
    JSON.stringify(
      {
        level: 'error',
        label,
        message: err?.message || String(error),
        stack: isProd ? undefined : err?.stack,
        timestamp: new Date().toISOString()
      },
      null,
      2
    )
  );
};

const emitAdmin = (event: string, payload: Record<string, unknown>) => {
  io.to('admin').emit(event, {
    ...payload,
    timestamp: new Date().toISOString()
  });
};

const emitUser = (userId: string, event: string, payload: Record<string, unknown>) => {
  io.to(`user:${userId}`).emit(event, {
    ...payload,
    timestamp: new Date().toISOString()
  });
};

const generateAdminToken = (userId: string, role: UserRole) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT secret missing');
  }

  return jwt.sign(
    {
      userId,
      role,
      scope: 'admin'
    },
    secret,
    {
      expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
      issuer: process.env.JWT_ISSUER || 'texa-api',
      audience: process.env.JWT_AUDIENCE || 'texa-client'
    }
  );
};

const assertAdminRole = (role: UserRole) => {
  return role === UserRole.ADMIN || role === UserRole.SUPERADMIN;
};

const getRequesterId = (req: Request) => {
  const value = (req as any).user?.id || (req as any).userId || (req as any).auth?.userId;
  return typeof value === 'string' ? value : undefined;
};

const getRequesterRole = (req: Request) => {
  const value = (req as any).user?.role || (req as any).role || (req as any).auth?.role;
  return typeof value === 'string' ? value : undefined;
};

const isSuperAdminRequest = (req: Request) => getRequesterRole(req) === UserRole.SUPERADMIN;

export const adminLogin = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = normalizeText(req.body.password);

    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required', 'MISSING_CREDENTIALS');
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !assertAdminRole(user.role)) {
      return sendError(res, 403, 'Unauthorized access', 'UNAUTHORIZED_ADMIN');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Admin account is banned', 'ADMIN_BANNED');
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return sendError(res, 401, 'Invalid admin credentials', 'INVALID_CREDENTIALS');
    }

    const token = generateAdminToken(user.id, user.role);

    const updatedAdmin = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: new Date(),
        loginStreak: {
          increment: 1
        }
      },
      select: adminUserSelect
    });

    emitAdmin('admin:login', {
      userId: user.id,
      role: user.role
    });

    return sendSuccess(res, 200, {
      token,
      admin: updatedAdmin
    });
  } catch (error) {
    logError('ADMIN_LOGIN_FAILED', error);
    return sendError(res, 500, 'Admin login failed', 'ADMIN_LOGIN_FAILED');
  }
};

export const listUsers = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = clampPagination(req);
    const search = normalizeText(req.query.search);
    const role = normalizeText(req.query.role).toUpperCase();
    const status = normalizeText(req.query.status).toLowerCase();

    const where: Prisma.UserWhereInput = {};

    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (role && Object.values(UserRole).includes(role as UserRole)) {
      where.role = role as UserRole;
    }

    if (status === 'verified') where.isVerified = true;
    if (status === 'unverified') where.isVerified = false;
    if (status === 'banned') where.isBanned = true;
    if (status === 'active') where.isBanned = false;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: publicUserSelect
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
    logError('LIST_USERS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch users', 'LIST_USERS_FAILED');
  }
};

export const manageUser = async (req: Request, res: Response) => {
  try {
    const userId = normalizeText(req.body.userId);
    const action = normalizeText(req.body.action).toLowerCase() as AdminAction;
    const reason = normalizeText(req.body.reason);

    if (!userId || !action) {
      return sendError(res, 400, 'User ID and action are required', 'MISSING_USER_ACTION');
    }

    const allowedActions: AdminAction[] = [
      'delete',
      'verify',
      'unverify',
      'ban',
      'unban',
      'promote_admin',
      'promote_creator',
      'demote_user'
    ];

    if (!allowedActions.includes(action)) {
      return sendError(res, 400, 'Invalid user action', 'INVALID_USER_ACTION');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (user.role === UserRole.SUPERADMIN && ['delete', 'ban', 'demote_user'].includes(action)) {
      return sendError(res, 403, 'Superadmin cannot be modified with this action', 'SUPERADMIN_PROTECTED');
    }

    if (['promote_admin', 'demote_user'].includes(action) && !isSuperAdminRequest(req)) {
      return sendError(res, 403, 'Only superadmin can change admin roles', 'SUPERADMIN_REQUIRED');
    }

    let updatedUser: Prisma.UserGetPayload<{ select: typeof publicUserSelect }> | null = null;

    if (action === 'delete') {
      await prisma.user.delete({
        where: { id: userId }
      });

      emitAdmin('admin:userDeleted', { userId });
      emitUser(userId, 'user:deleted', { userId });

      return sendSuccess(res, 200, {
        status: 'deleted',
        userId
      });
    }

    if (action === 'verify') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { isVerified: true },
        select: publicUserSelect
      });
    }

    if (action === 'unverify') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { isVerified: false },
        select: publicUserSelect
      });
    }

    if (action === 'ban') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          isBanned: true,
          banReason: reason || 'Admin action'
        },
        select: publicUserSelect
      });
    }

    if (action === 'unban') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          isBanned: false,
          banReason: null
        },
        select: publicUserSelect
      });
    }

    if (action === 'promote_admin') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.ADMIN },
        select: publicUserSelect
      });
    }

    if (action === 'promote_creator') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.CREATOR },
        select: publicUserSelect
      });
    }

    if (action === 'demote_user') {
      updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.USER },
        select: publicUserSelect
      });
    }

    emitAdmin('admin:userUpdated', {
      userId,
      action,
      user: updatedUser
    });

    emitUser(userId, 'user:adminUpdated', {
      action,
      user: updatedUser
    });

    return sendSuccess(res, 200, {
      status: 'updated',
      action,
      user: updatedUser
    });
  } catch (error) {
    logError('MANAGE_USER_FAILED', error);
    return sendError(res, 500, 'Failed to manage user', 'MANAGE_USER_FAILED');
  }
};

export const toggleVerify = async (req: Request, res: Response) => {
  try {
    const userId = normalizeText(req.body.userId);
    const verify = req.body.verify;

    if (!userId || typeof verify !== 'boolean') {
      return sendError(res, 400, 'Invalid verification request', 'INVALID_VERIFY_REQUEST');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { isVerified: verify },
      select: publicUserSelect
    });

    emitAdmin('admin:verifyUpdated', {
      userId,
      verify,
      user: updatedUser
    });

    emitUser(userId, 'user:verificationUpdated', {
      verify,
      user: updatedUser
    });

    return sendSuccess(res, 200, {
      status: verify ? 'verified' : 'unverified',
      user: updatedUser
    });
  } catch (error) {
    logError('TOGGLE_VERIFY_FAILED', error);
    return sendError(res, 500, 'Failed to update verification', 'TOGGLE_VERIFY_FAILED');
  }
};

export const resetUserPass = async (req: Request, res: Response) => {
  try {
    const userId = normalizeText(req.body.userId);
    const newPass = normalizeText(req.body.newPass);

    if (!userId || !newPass) {
      return sendError(res, 400, 'User ID and new password are required', 'MISSING_PASSWORD_RESET_FIELDS');
    }

    if (newPass.length < 8) {
      return sendError(res, 400, 'Password must be at least 8 characters', 'WEAK_PASSWORD');
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true
      }
    });

    if (!target) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (target.role === UserRole.SUPERADMIN && !isSuperAdminRequest(req)) {
      return sendError(res, 403, 'Only superadmin can reset superadmin password', 'SUPERADMIN_REQUIRED');
    }

    const hashedPassword = await bcrypt.hash(newPass, Number(process.env.BCRYPT_ROUNDS || 12));

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        backupCodes: []
      }
    });

    emitAdmin('admin:passwordReset', { userId });
    emitUser(userId, 'user:passwordReset', { userId });

    return sendSuccess(res, 200, {
      status: 'password_reset'
    });
  } catch (error) {
    logError('RESET_USER_PASSWORD_FAILED', error);
    return sendError(res, 500, 'Failed to reset password', 'RESET_USER_PASSWORD_FAILED');
  }
};

export const manageCoinsXP = async (req: Request, res: Response) => {
  try {
    const userId = normalizeText(req.body.userId);
    const mode = (normalizeText(req.body.mode).toLowerCase() || 'set') as WalletMode;
    const sourceText = normalizeText(req.body.source).toUpperCase();
    const reason = normalizeText(req.body.reason);
    const referenceId = normalizeText(req.body.referenceId) || undefined;
    const coinsInput = req.body.coins;
    const xpInput = req.body.xp;

    if (!userId) {
      return sendError(res, 400, 'User ID required', 'USER_ID_REQUIRED');
    }

    if (!['set', 'increment', 'decrement'].includes(mode)) {
      return sendError(res, 400, 'Invalid wallet update mode', 'INVALID_WALLET_MODE');
    }

    const hasCoins = coinsInput !== undefined && coinsInput !== null && coinsInput !== '';
    const hasXp = xpInput !== undefined && xpInput !== null && xpInput !== '';

    if (!hasCoins && !hasXp) {
      return sendError(res, 400, 'Coins or XP value required', 'MISSING_WALLET_VALUES');
    }

    const source = Object.values(WalletSource).includes(sourceText as WalletSource)
      ? (sourceText as WalletSource)
      : WalletSource.ADMIN;

    const coinsValue = hasCoins ? Number(coinsInput) : undefined;
    const xpValue = hasXp ? Number(xpInput) : undefined;

    if (coinsValue !== undefined && !Number.isFinite(coinsValue)) {
      return sendError(res, 400, 'Invalid coins value', 'INVALID_COINS_VALUE');
    }

    if (xpValue !== undefined && !Number.isFinite(xpValue)) {
      return sendError(res, 400, 'Invalid XP value', 'INVALID_XP_VALUE');
    }

    const result = await withTransaction(async tx => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          coins: true,
          xp: true
        }
      });

      if (!user) {
        throw Object.assign(new Error('User not found'), { status: 404, code: 'USER_NOT_FOUND' });
      }

      const nextCoins =
        coinsValue === undefined
          ? user.coins
          : mode === 'increment'
            ? Math.max(0, user.coins + Math.trunc(coinsValue))
            : mode === 'decrement'
              ? Math.max(0, user.coins - Math.abs(Math.trunc(coinsValue)))
              : Math.max(0, Math.trunc(coinsValue));

      const nextXp =
        xpValue === undefined
          ? user.xp
          : mode === 'increment'
            ? Math.max(0, user.xp + Math.trunc(xpValue))
            : mode === 'decrement'
              ? Math.max(0, user.xp - Math.abs(Math.trunc(xpValue)))
              : Math.max(0, Math.trunc(xpValue));

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          coins: nextCoins,
          xp: nextXp
        },
        select: publicUserSelect
      });

      let coinTransaction = null;

      if (coinsValue !== undefined && nextCoins !== user.coins) {
        coinTransaction = await tx.coinTransaction.create({
          data: {
            userId,
            type: nextCoins >= user.coins ? TransactionType.CREDIT : TransactionType.DEBIT,
            status: TransactionStatus.SUCCESS,
            source,
            amount: Math.abs(nextCoins - user.coins),
            balance: nextCoins,
            referenceId,
            metadata: {
              mode,
              reason: reason || 'Admin wallet update',
              previousCoins: user.coins,
              nextCoins,
              previousXp: user.xp,
              nextXp,
              adminId: getRequesterId(req) || null
            }
          }
        });
      }

      return {
        user: updatedUser,
        transaction: coinTransaction,
        previous: {
          coins: user.coins,
          xp: user.xp
        },
        current: {
          coins: nextCoins,
          xp: nextXp
        }
      };
    });

    emitAdmin('admin:coinsXpUpdated', {
      userId,
      mode,
      previous: result.previous,
      current: result.current
    });

    emitUser(userId, 'user:walletUpdated', {
      mode,
      previous: result.previous,
      current: result.current,
      user: result.user
    });

    return sendSuccess(res, 200, {
      status: 'updated',
      ...result
    });
  } catch (error: any) {
    logError('MANAGE_COINS_XP_FAILED', error);
    return sendError(
      res,
      Number(error?.status || 500),
      error?.message || 'Failed to update coins/xp',
      error?.code || 'MANAGE_COINS_XP_FAILED'
    );
  }
};

export const manageReports = async (req: Request, res: Response) => {
  try {
    const reportId = normalizeText(req.body.reportId);
    const action = normalizeText(req.body.action).toLowerCase() as ReportAction;
    const note = normalizeText(req.body.note);

    if (!reportId || !action) {
      return sendError(res, 400, 'Report ID and action required', 'MISSING_REPORT_ACTION');
    }

    const allowedActions: ReportAction[] = ['resolve', 'reject', 'review', 'delete_target'];

    if (!allowedActions.includes(action)) {
      return sendError(res, 400, 'Invalid report action', 'INVALID_REPORT_ACTION');
    }

    const report = await prisma.report.findUnique({
      where: { id: reportId }
    });

    if (!report) {
      return sendError(res, 404, 'Report not found', 'REPORT_NOT_FOUND');
    }

    const nextStatus =
      action === 'resolve'
        ? 'resolved'
        : action === 'reject'
          ? 'rejected'
          : action === 'review'
            ? 'review'
            : 'target_deleted';

    const updatedReport = await prisma.report.update({
      where: { id: reportId },
      data: {
        status: nextStatus,
        details: note ? `${report.details || ''}\nAdmin note: ${note}`.trim() : report.details
      }
    });

    emitAdmin('admin:reportUpdated', {
      reportId,
      action,
      report: updatedReport
    });

    return sendSuccess(res, 200, {
      status: 'handled',
      report: updatedReport
    });
  } catch (error) {
    logError('MANAGE_REPORTS_FAILED', error);
    return sendError(res, 500, 'Failed to manage reports', 'MANAGE_REPORTS_FAILED');
  }
};

export const manageContent = async (req: Request, res: Response) => {
  try {
    const type = normalizeText(req.body.type).toLowerCase() as ContentType;
    const id = normalizeText(req.body.id);
    const action = (normalizeText(req.body.action).toLowerCase() || 'hide') as ContentAction;
    const reason = normalizeText(req.body.reason);

    if (!type || !id) {
      return sendError(res, 400, 'Content type and ID required', 'MISSING_CONTENT_FIELDS');
    }

    const allowedTypes: ContentType[] = [
      'reel',
      'story',
      'comment',
      'room',
      'store',
      'product',
      'message',
      'moderation_report'
    ];

    if (!allowedTypes.includes(type)) {
      return sendError(res, 400, 'Invalid content type', 'INVALID_CONTENT_TYPE');
    }

    let result: unknown = null;

    if (type === 'reel') {
      if (action === 'delete') {
        result = await prisma.reel.delete({ where: { id } });
      } else {
        const status =
          action === 'block' || action === 'hide'
            ? ModerationStatus.BLOCKED
            : action === 'review'
              ? ModerationStatus.REVIEW
              : ModerationStatus.SAFE;

        result = await prisma.reel.update({
          where: { id },
          data: {
            moderationStatus: status,
            flaggedReason: reason || null
          }
        });
      }
    }

    if (type === 'story') {
      if (action === 'delete') {
        result = await prisma.story.delete({ where: { id } });
      } else {
        const status =
          action === 'block' || action === 'hide'
            ? ModerationStatus.BLOCKED
            : action === 'review'
              ? ModerationStatus.REVIEW
              : ModerationStatus.SAFE;

        result = await prisma.story.update({
          where: { id },
          data: {
            moderationStatus: status,
            flagged: status !== ModerationStatus.SAFE
          }
        });
      }
    }

    if (type === 'comment') {
      if (action === 'delete') {
        result = await prisma.comment.delete({ where: { id } });
      } else {
        const status =
          action === 'block' || action === 'hide'
            ? ModerationStatus.BLOCKED
            : action === 'review'
              ? ModerationStatus.REVIEW
              : ModerationStatus.SAFE;

        result = await prisma.comment.update({
          where: { id },
          data: {
            moderationStatus: status
          }
        });
      }
    }

    if (type === 'room') {
      if (action === 'delete') {
        result = await prisma.voiceRoom.delete({ where: { id } });
      } else {
        const suspend = action === 'suspend' || action === 'hide' || action === 'block';

        result = await prisma.voiceRoom.update({
          where: { id },
          data: {
            status: suspend ? RoomStatus.SUSPENDED : RoomStatus.LIVE,
            isActive: !suspend,
            endedAt: suspend ? new Date() : null
          }
        });
      }
    }

    if (type === 'store') {
      if (action === 'delete') {
        result = await prisma.store.delete({ where: { id } });
      } else {
        result = await prisma.store.update({
          where: { id },
          data: {
            isVerified: action === 'verify' || action === 'activate' || action === 'restore'
          }
        });
      }
    }

    if (type === 'product') {
      if (action === 'delete') {
        result = await prisma.product.delete({ where: { id } });
      } else {
        const status =
          action === 'archive' || action === 'hide' || action === 'block'
            ? ProductStatus.ARCHIVED
            : action === 'activate' || action === 'restore'
              ? ProductStatus.ACTIVE
              : ProductStatus.DRAFT;

        result = await prisma.product.update({
          where: { id },
          data: { status }
        });
      }
    }

    if (type === 'message') {
      if (action === 'delete' || action === 'hide' || action === 'block') {
        result = await prisma.message.update({
          where: { id },
          data: {
            deletedAt: new Date()
          }
        });
      } else {
        result = await prisma.message.update({
          where: { id },
          data: {
            deletedAt: null
          }
        });
      }
    }

    if (type === 'moderation_report') {
      const status =
        action === 'block' || action === 'hide'
          ? ModerationStatus.BLOCKED
          : action === 'safe' || action === 'restore'
            ? ModerationStatus.SAFE
            : ModerationStatus.REVIEW;

      result = await prisma.moderationReport.update({
        where: { id },
        data: {
          status,
          reviewedBy: getRequesterId(req) || null,
          reviewedAt: new Date()
        }
      });
    }

    emitAdmin('admin:contentManaged', {
      type,
      id,
      action,
      reason,
      result
    });

    return sendSuccess(res, 200, {
      status: 'content_managed',
      type,
      id,
      action,
      result
    });
  } catch (error) {
    logError('MANAGE_CONTENT_FAILED', error);
    return sendError(res, 500, 'Failed to manage content', 'MANAGE_CONTENT_FAILED');
  }
};

export const setAnnouncement = async (req: Request, res: Response) => {
  try {
    const title = normalizeText(req.body.title);
    const content = normalizeText(req.body.content);
    const audience = normalizeText(req.body.audience) || 'all';
    const priority = normalizeText(req.body.priority) || 'normal';

    if (!title || !content) {
      return sendError(res, 400, 'Title and content required', 'MISSING_ANNOUNCEMENT_FIELDS');
    }

    const announcement = {
      id: `ann_${Date.now()}`,
      title,
      content,
      audience,
      priority,
      createdBy: getRequesterId(req) || null,
      createdAt: new Date().toISOString()
    };

    if (audience === 'all') {
      const users = await prisma.user.findMany({
        where: {
          isBanned: false
        },
        select: {
          id: true
        },
        take: 500
      });

      await prisma.notification.createMany({
        data: users.map(user => ({
          userId: user.id,
          type: 'SYSTEM',
          title,
          body: content,
          data: announcement
        }))
      });
    }

    io.to('global').emit('announcement:new', announcement);
    emitAdmin('admin:announcementCreated', { announcement });

    return sendSuccess(res, 201, {
      announcement
    });
  } catch (error) {
    logError('SET_ANNOUNCEMENT_FAILED', error);
    return sendError(res, 500, 'Failed to create announcement', 'SET_ANNOUNCEMENT_FAILED');
  }
};

export const getAnalytics = async (_req: Request, res: Response) => {
  try {
    const [
      totalUsers,
      verifiedUsers,
      bannedUsers,
      creators,
      admins,
      activeRooms,
      totalRooms,
      totalReels,
      safeReels,
      reviewReels,
      blockedReels,
      totalStories,
      totalComments,
      pendingReports,
      totalReports,
      moderationReview,
      totalStores,
      verifiedStores,
      totalProducts,
      activeProducts,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      capturedPayments,
      coinTransactions,
      latestUsers,
      latestReports,
      latestOrders,
      latestReels
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isVerified: true } }),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { role: UserRole.CREATOR } }),
      prisma.user.count({ where: { role: { in: [UserRole.ADMIN, UserRole.SUPERADMIN] } } }),
      prisma.voiceRoom.count({ where: { isActive: true } }),
      prisma.voiceRoom.count(),
      prisma.reel.count(),
      prisma.reel.count({ where: { moderationStatus: ModerationStatus.SAFE } }),
      prisma.reel.count({ where: { moderationStatus: ModerationStatus.REVIEW } }),
      prisma.reel.count({ where: { moderationStatus: ModerationStatus.BLOCKED } }),
      prisma.story.count(),
      prisma.comment.count(),
      prisma.report.count({ where: { status: 'pending' } }),
      prisma.report.count(),
      prisma.moderationReport.count({ where: { status: ModerationStatus.REVIEW } }),
      prisma.store.count(),
      prisma.store.count({ where: { isVerified: true } }),
      prisma.product.count(),
      prisma.product.count({ where: { status: ProductStatus.ACTIVE } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: OrderStatus.PENDING } }),
      prisma.order.count({ where: { status: OrderStatus.DELIVERED } }),
      prisma.order.count({ where: { paymentStatus: PaymentStatus.CAPTURED } }),
      prisma.coinTransaction.count(),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: publicUserSelect
      }),
      prisma.report.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          reporter: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true
            }
          }
        }
      }),
      prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
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
          }
        }
      }),
      prisma.reel.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          author: {
            select: {
              id: true,
              username: true,
              fullName: true,
              avatarUrl: true
            }
          }
        }
      })
    ]);

    return sendSuccess(res, 200, {
      analytics: {
        users: {
          total: totalUsers,
          verified: verifiedUsers,
          banned: bannedUsers,
          creators,
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
        comments: {
          total: totalComments
        },
        reports: {
          total: totalReports,
          pending: pendingReports,
          moderationReview
        },
        commerce: {
          stores: totalStores,
          verifiedStores,
          products: totalProducts,
          activeProducts,
          orders: totalOrders,
          pendingOrders,
          deliveredOrders,
          capturedPayments
        },
        wallet: {
          transactions: coinTransactions
        },
        latest: {
          users: latestUsers,
          reports: latestReports,
          orders: latestOrders,
          reels: latestReels
        }
      }
    });
  } catch (error) {
    logError('GET_ANALYTICS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch analytics', 'GET_ANALYTICS_FAILED');
  }
};

export const listReports = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = clampPagination(req);
    const status = normalizeText(req.query.status).toLowerCase();
    const targetType = normalizeText(req.query.targetType);

    const where: Prisma.ReportWhereInput = {};

    if (status) where.status = status;
    if (targetType) where.targetType = targetType;

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
              email: true
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
    logError('LIST_REPORTS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch reports', 'LIST_REPORTS_FAILED');
  }
};

export const listStores = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = clampPagination(req);
    const search = normalizeText(req.query.search);
    const verified = normalizeText(req.query.verified).toLowerCase();

    const where: Prisma.StoreWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (verified === 'true') where.isVerified = true;
    if (verified === 'false') where.isVerified = false;

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
              email: true
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
    logError('LIST_STORES_FAILED', error);
    return sendError(res, 500, 'Failed to fetch stores', 'LIST_STORES_FAILED');
  }
};

export const listOrders = async (req: Request, res: Response) => {
  try {
    const { page, limit, skip } = clampPagination(req);
    const status = normalizeText(req.query.status).toUpperCase();
    const paymentStatus = normalizeText(req.query.paymentStatus).toUpperCase();
    const search = normalizeText(req.query.search);

    const where: Prisma.OrderWhereInput = {};

    if (status && Object.values(OrderStatus).includes(status as OrderStatus)) {
      where.status = status as OrderStatus;
    }

    if (paymentStatus && Object.values(PaymentStatus).includes(paymentStatus as PaymentStatus)) {
      where.paymentStatus = paymentStatus as PaymentStatus;
    }

    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { trackingNumber: { contains: search, mode: 'insensitive' } },
        { buyer: { username: { contains: search, mode: 'insensitive' } } },
        { buyer: { fullName: { contains: search, mode: 'insensitive' } } },
        { store: { name: { contains: search, mode: 'insensitive' } } }
      ];
    }

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
              avatarUrl: true,
              email: true
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
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  primaryMediaUrl: true,
                  price: true
                }
              }
            }
          }
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
    logError('LIST_ORDERS_FAILED', error);
    return sendError(res, 500, 'Failed to fetch orders', 'LIST_ORDERS_FAILED');
  }
};

export const getAdminDashboard = async (req: Request, res: Response) => {
  return getAnalytics(req, res);
};
