import { Request, Response, NextFunction } from 'express';
export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (req.role !== 'ADMIN' && req.role !== 'SUPERADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
};
