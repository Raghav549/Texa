import { Request, Response } from 'express';
import { prisma } from '../config/db';
export const listUsers = async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({ select: { id: true, username: true, fullName: true, email: true, coins: true, xp: true, level: true, isVerified: true, followers: true, role: true } });
  res.json(users);
};
export const banUser = async (req: Request, res: Response) => {
  const { userId } = req.body;
  await prisma.user.update({ where: { id: userId },  { isVerified: false } });
  res.json({ status: 'banned' });
};
export const toggleVerify = async (req: Request, res: Response) => {
  const { userId, verify } = req.body;
  await prisma.user.update({ where: { id: userId },  { isVerified: verify } });
  res.json({ status: verify ? 'verified' : 'unverified' });
};
