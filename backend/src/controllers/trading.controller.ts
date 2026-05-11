import { Request, Response } from 'express';
import { prisma } from '../config/db';
export const getActiveTrade = async (_req: Request, res: Response) => {
  const trade = await prisma.tradeDay.findFirst({ where: { isActive: true }, orderBy: { date: 'desc' } });
  res.json(trade);
};
