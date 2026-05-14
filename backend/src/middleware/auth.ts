import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload as BaseJwtPayload } from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { prisma } from '../config/db';

type TokenPayload = BaseJwtPayload & {
  userId?: string;
  id?: string;
  sub?: string;
  role?: UserRole | string;
};

type AuthenticatedRequest = Request & {
  userId?: string;
  role?: UserRole | string;
  user?: {
    id: string;
    role: UserRole;
    username?: string | null;
    avatarUrl?: string | null;
    isVerified?: boolean | null;
  };
};

const ADMIN_ROLES = new Set<string>(['ADMIN', 'SUPERADMIN', 'OWNER']);

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  return secret;
};

const normalizeRole = (role: unknown) => {
  return String(role || '').trim().toUpperCase();
};

const extractBearerToken = (req: Request) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const cookieToken =
    (req as any).cookies?.token ||
    (req as any).cookies?.accessToken ||
    (req as any).cookies?.authToken;

  if (cookieToken) {
    return String(cookieToken).trim();
  }

  const headerToken =
    req.headers['x-access-token'] ||
    req.headers['x-auth-token'] ||
    req.headers.token;

  if (Array.isArray(headerToken)) {
    return String(headerToken[0] || '').trim();
  }

  if (headerToken) {
    return String(headerToken).replace(/^Bearer\s+/i, '').trim();
  }

  return '';
};

const sendAuthError = (res: Response, status: number, message: string) => {
  return res.status(status).json({
    success: false,
    error: message,
    message
  });
};

const verifyToken = (token: string) => {
  return jwt.verify(token, getJwtSecret()) as TokenPayload;
};

const getUserIdFromPayload = (payload: TokenPayload) => {
  return payload.userId || payload.id || payload.sub || '';
};

const attachUserToRequest = (req: AuthenticatedRequest, user: any) => {
  req.userId = user.id;
  req.role = user.role;
  req.user = {
    id: user.id,
    role: user.role,
    username: user.username ?? null,
    avatarUrl: user.avatarUrl ?? null,
    isVerified: user.isVerified ?? false
  };
  (req as any).auth = {
    userId: user.id,
    role: user.role
  };
};

export const auth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return sendAuthError(res, 401, 'Authentication token missing');
    }

    const decoded = verifyToken(token);
    const userId = getUserIdFromPayload(decoded);

    if (!userId) {
      return sendAuthError(res, 401, 'Invalid token payload');
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        role: true,
        username: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    if (!user) {
      return sendAuthError(res, 401, 'User no longer exists');
    }

    attachUserToRequest(req, user);

    return next();
  } catch (error: any) {
    console.error('Auth Middleware Error:', error);

    if (error instanceof jwt.TokenExpiredError) {
      return sendAuthError(res, 401, 'Token expired');
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return sendAuthError(res, 401, 'Invalid authentication token');
    }

    return sendAuthError(res, 500, error?.message || 'Authentication failed');
  }
};

export const optionalAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return next();
    }

    const decoded = verifyToken(token);
    const userId = getUserIdFromPayload(decoded);

    if (!userId) {
      return next();
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        role: true,
        username: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    if (user) {
      attachUserToRequest(req, user);
    }

    return next();
  } catch {
    return next();
  }
};

export const adminOnly = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const role = normalizeRole(req.role || req.user?.role || (req as any).auth?.role);

    if (ADMIN_ROLES.has(role)) {
      return next();
    }

    if (!req.userId) {
      return sendAuthError(res, 401, 'Authentication required');
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.userId
      },
      select: {
        id: true,
        role: true,
        username: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    if (!user) {
      return sendAuthError(res, 401, 'Invalid user session');
    }

    attachUserToRequest(req, user);

    if (!ADMIN_ROLES.has(normalizeRole(user.role))) {
      return sendAuthError(res, 403, 'Admin access required');
    }

    return next();
  } catch (error: any) {
    console.error('Admin Middleware Error:', error);
    return sendAuthError(res, 500, error?.message || 'Admin authorization failed');
  }
};

export const superAdminOnly = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const role = normalizeRole(req.role || req.user?.role || (req as any).auth?.role);

    if (role === 'SUPERADMIN' || role === 'OWNER') {
      return next();
    }

    if (!req.userId) {
      return sendAuthError(res, 401, 'Authentication required');
    }

    const user = await prisma.user.findUnique({
      where: {
        id: req.userId
      },
      select: {
        id: true,
        role: true,
        username: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    if (!user) {
      return sendAuthError(res, 401, 'Invalid user session');
    }

    attachUserToRequest(req, user);

    const freshRole = normalizeRole(user.role);

    if (freshRole !== 'SUPERADMIN' && freshRole !== 'OWNER') {
      return sendAuthError(res, 403, 'Super admin access required');
    }

    return next();
  } catch (error: any) {
    console.error('Super Admin Middleware Error:', error);
    return sendAuthError(res, 500, error?.message || 'Super admin authorization failed');
  }
};

export const authorize = (...roles: UserRole[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const allowed = new Set(roles.map(role => normalizeRole(role)));
      const role = normalizeRole(req.role || req.user?.role || (req as any).auth?.role);

      if (role && allowed.has(role)) {
        return next();
      }

      if (!req.userId) {
        return sendAuthError(res, 401, 'Authentication required');
      }

      const user = await prisma.user.findUnique({
        where: {
          id: req.userId
        },
        select: {
          id: true,
          role: true,
          username: true,
          avatarUrl: true,
          isVerified: true
        }
      });

      if (!user) {
        return sendAuthError(res, 401, 'Invalid user session');
      }

      attachUserToRequest(req, user);

      if (!allowed.has(normalizeRole(user.role))) {
        return sendAuthError(res, 403, 'Access denied');
      }

      return next();
    } catch (error: any) {
      console.error('Authorize Middleware Error:', error);
      return sendAuthError(res, 500, error?.message || 'Authorization failed');
    }
  };
};

export const requireAuth = auth;
export const authMiddleware = auth;
export const authenticate = auth;
export const protect = auth;
