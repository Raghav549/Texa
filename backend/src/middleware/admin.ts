import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';

type AdminRole = 'ADMIN' | 'SUPERADMIN' | 'OWNER';

const ADMIN_ROLES = new Set<AdminRole>(['ADMIN', 'SUPERADMIN', 'OWNER']);

const normalizeRole = (value: unknown): string => {
  return String(value || '').trim().toUpperCase();
};

const readRequestRole = (req: Request): string => {
  return normalizeRole(
    (req as any).role ||
      (req as any).userRole ||
      (req as any).user?.role ||
      (req as any).auth?.role
  );
};

const readRequestUserId = (req: Request): string | undefined => {
  const value =
    (req as any).userId ||
    (req as any).user?.id ||
    (req as any).auth?.userId ||
    (req as any).auth?.id;

  return value ? String(value) : undefined;
};

const isAdminRole = (role: unknown): boolean => {
  return ADMIN_ROLES.has(normalizeRole(role) as AdminRole);
};

export const adminOnly = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestRole = readRequestRole(req);

    if (isAdminRole(requestRole)) {
      return next();
    }

    const userId = readRequestUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        role: true,
        isBanned: true,
        deletedAt: true
      } as any
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid user session'
      });
    }

    if ((user as any).deletedAt) {
      return res.status(403).json({
        error: 'Account is no longer active'
      });
    }

    if ((user as any).isBanned) {
      return res.status(403).json({
        error: 'Account is restricted'
      });
    }

    if (!isAdminRole((user as any).role)) {
      return res.status(403).json({
        error: 'Admin access required'
      });
    }

    (req as any).role = normalizeRole((user as any).role);
    (req as any).userRole = normalizeRole((user as any).role);
    (req as any).userId = user.id;

    return next();
  } catch (error) {
    console.error('Admin middleware error:', error);

    return res.status(500).json({
      error: 'Internal server error'
    });
  }
};

export const superAdminOnly = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestRole = readRequestRole(req);

    if (requestRole === 'SUPERADMIN' || requestRole === 'OWNER') {
      return next();
    }

    const userId = readRequestUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        role: true,
        isBanned: true,
        deletedAt: true
      } as any
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid user session'
      });
    }

    if ((user as any).deletedAt) {
      return res.status(403).json({
        error: 'Account is no longer active'
      });
    }

    if ((user as any).isBanned) {
      return res.status(403).json({
        error: 'Account is restricted'
      });
    }

    const role = normalizeRole((user as any).role);

    if (role !== 'SUPERADMIN' && role !== 'OWNER') {
      return res.status(403).json({
        error: 'Super admin access required'
      });
    }

    (req as any).role = role;
    (req as any).userRole = role;
    (req as any).userId = user.id;

    return next();
  } catch (error) {
    console.error('Super admin middleware error:', error);

    return res.status(500).json({
      error: 'Internal server error'
    });
  }
};

export const ownerOnly = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestRole = readRequestRole(req);

    if (requestRole === 'OWNER') {
      return next();
    }

    const userId = readRequestUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true,
        role: true,
        isBanned: true,
        deletedAt: true
      } as any
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid user session'
      });
    }

    if ((user as any).deletedAt) {
      return res.status(403).json({
        error: 'Account is no longer active'
      });
    }

    if ((user as any).isBanned) {
      return res.status(403).json({
        error: 'Account is restricted'
      });
    }

    const role = normalizeRole((user as any).role);

    if (role !== 'OWNER') {
      return res.status(403).json({
        error: 'Owner access required'
      });
    }
    
    (req as any).role = role;
    (req as any).userRole = role;
    (req as any).userId = user.id;

    return next();
  } catch (error) {
    console.error('Owner middleware error:', error);

    return res.status(500).json({
      error: 'Internal server error'
    });
  }
};
