import {
  Request,
  Response,
  NextFunction
} from 'express';

import jwt from 'jsonwebtoken';

// =====================================
// AUTH MIDDLEWARE
// =====================================

export const auth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {

  try {

    const authHeader =
      req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith(
        'Bearer '
      )
    ) {

      return res.status(401).json({
        error:
          'Missing token'
      });
    }

    const token =
      authHeader.split(' ')[1];

    if (!token) {

      return res.status(401).json({
        error:
          'Invalid token format'
      });
    }

    const decoded =
      jwt.verify(
        token,
        process.env
          .JWT_SECRET as string
      ) as {
        userId: string;
        role: string;
      };

    req.userId =
      decoded.userId;

    req.role =
      decoded.role;

    next();

  } catch (error) {

    console.error(
      'Auth middleware error:',
      error
    );

    return res.status(403).json({
      error:
        'Invalid token'
    });
  }
};

// =====================================
// EXPRESS TYPES
// =====================================

declare global {

  namespace Express {

    interface Request {

      userId?: string;

      role?: string;
    }
  }
}
