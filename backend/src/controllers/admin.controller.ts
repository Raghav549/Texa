import { Request, Response } from 'express';
import { prisma } from '../config/db';
import bcrypt from 'bcrypt';
export const listUsers = async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({ select: { id: true, username: true, fullName: true, email: true, coins: true, xp: true, level: true, isVerified: true, role: true } });
  res.json(users);
};
export const manageUser = async (req: Request, res: Response) => {
  const { userId, action } = req.body;
  if (action === 'ban') await prisma.user.update({ where: { id: userId },  { isVerified: false } });
  if (action === 'delete') await prisma.user.delete({ where: { id: userId } });
  res.json({ status: 'ok' });
};
export const resetPassword = async (req: Request, res: Response) => {
  const { userId, newPass } = req.body;
  await prisma.user.update({ where: { id: userId },  { password: await bcrypt.hash(newPass, 10) } });
  res.json({ status: 'reset' });
};
export const manageCoins = async (req: Request, res: Response) => {
  const { userId, coins } = req.body;
  await prisma.user.update({ where: { id: userId },  { coins } });
  res.json({ status: 'updated' });
};
export const deleteContent = async (req: Request, res: Response) => {
  const { type, id } = req.body;
  if (type === 'story') await prisma.story.delete({ where: { id } });
  if (type === 'reel') await prisma.reel.delete({ where: { id } });
  res.json({ status: 'deleted' });
};
export const manageReports = async (_req: Request, res: Response) => {
  const reports = await prisma.report.findMany({ include: { reporter: { select: { username: true } } } });
  res.json(reports);
};
export const setAnnouncement = async (req: Request, res: Response) => {
  await prisma.announcement.create({  req.body });
  res.json({ status: 'posted' });
};
export const getAnalytics = async (_req: Request, res: Response) => {
  const users = await prisma.user.count();
  const rooms = await prisma.voiceRoom.count({ where: { isActive: true } });
  const reels = await prisma.reel.count();
  res.json({ users, activeRooms: rooms, totalReels: reels });
};
