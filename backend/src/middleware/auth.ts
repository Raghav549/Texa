import {

  Request,
  Response,
  NextFunction

} from 'express';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/prisma';

import { Role } from '@prisma/client';

// ============================================
// JWT PAYLOAD
// ============================================

interface JwtPayload {

  userId: string;

  role: Role;

}

// ============================================
// AUTH MIDDLEWARE
// ============================================

export const auth = async (

  req: Request,
  res: Response,
  next: NextFunction

) => {

  try {

    const authHeader = req.headers.authorization;

    if (

      !authHeader ||

      !authHeader.startsWith('Bearer ')

    ) {

      return res.status(401).json({

        success: false,

        message: 'Authentication token missing',

      });

    }

    const token = authHeader.split(' ')[1];

    if (!token) {

      return res.status(401).json({

        success: false,

        message: 'Invalid token format',

      });

    }

    const decoded = jwt.verify(

      token,

      process.env.JWT_SECRET as string

    ) as JwtPayload;

    // ============================================
    // VERIFY USER EXISTS
    // ============================================

    const user = await prisma.user.findUnique({

      where: {

        id: decoded.userId,

      },

      select: {

        id: true,
        role: true,

      },

    });

    if (!user) {

      return res.status(401).json({

        success: false,

        message: 'User no longer exists',

      });

    }

    req.userId = user.id;

    req.role = user.role;

    next();

  } catch (error) {

    console.error('Auth Middleware Error:', error);

    if (error instanceof jwt.TokenExpiredError) {

      return res.status(401).json({

        success: false,

        message: 'Token expired',

      });

    }

    return res.status(401).json({

      success: false,

      message: 'Invalid authentication token',

    });

  }

};

// ============================================
// ADMIN ONLY
// ============================================

export const adminOnly = (

  req: Request,
  res: Response,
  next: NextFunction

) => {

  if (

    req.role !== 'ADMIN' &&

    req.role !== 'SUPERADMIN'

  ) {

    return res.status(403).json({

      success: false,

      message: 'Admin access required',

    });

  }

  next();

};

// ============================================
// ROLE AUTHORIZATION
// ============================================

export const authorize = (...roles: Role[]) => {

  return (

    req: Request,
    res: Response,
    next: NextFunction

  ) => {

    if (

      !req.role ||

      !roles.includes(req.role as Role)

    ) {

      return res.status(403).json({

        success: false,

        message: 'Access denied',

      });

    }

    next();

  };

};
