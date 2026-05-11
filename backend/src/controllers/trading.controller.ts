import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';

export const getActiveTrade = async (_req: Request, res: Response) => {
  const trade = await prisma.tradeDay.findFirst({ where: { isActive: true }, orderBy: { date: 'desc' } });
  res.json(trade || { choices: [], isActive: false });
};

export const adminSetChoices = async (req: Request, res: Response) => {
  const { choices } = req.body;
  await prisma.tradeDay.updateMany({ where: { isActive: true },  { choices, isActive: false } });
  const newTrade = await prisma.tradeDay.create({ data: { date: new Date(), choices, isActive: true } });
  io.emit('trading:reset', { choices, tradeId: newTrade.id });
  res.json({ status: 'updated' });
};
