import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
export const auth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string, role: string };
    req.userId = decoded.userId;
    req.role = decoded.role;
    next();
  } catch { res.status(403).json({ error: 'Invalid token' }); }
};

declare global { namespace Express { interface Request { userId?: string; role?: string; } } }
