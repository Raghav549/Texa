import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';
import bcrypt from 'bcrypt';

export const adminLogin = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !['ADMIN', 'SUPERADMIN'].includes(user.role)) return res.status(403).json({ error: 'Unauthorized' });
  if (!user.passwordVerified || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid admin credentials' });
  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '12h' });
  res.json({ token });
};

export const listUsers = async (req: Request, res: Response) => {
  const users = await prisma.user.findMany({ select: { id: true, username: true, fullName: true, email: true, coins: true, xp: true, level: true, isVerified: true, role: true, isSuspended: true, followers: true, createdAt: true } });
  res.json(users);
};

export const manageUser = async (req: Request, res: Response) => {
  const { userId, action } = req.body;
  if (action === 'ban') await prisma.user.update({ where: { id: userId }, data: { isSuspended: true } });
  if (action === 'unban') await prisma.user.update({ where: { id: userId }, data: { isSuspended: false } });
  if (action === 'delete') await prisma.user.delete({ where: { id: userId } });
  io.emit('admin:userUpdated', { userId, action });
  res.json({ status: 'ok' });
};

export const toggleVerify = async (req: Request, res: Response) => {
  const { userId, verify } = req.body;
  await prisma.user.update({ where: { id: userId }, data: { isVerified: verify } });
  io.emit('admin:verifyUpdated', { userId, verify });
  res.json({ status: verify ? 'verified' : 'unverified' });
};

export const resetUserPass = async (req: Request, res: Response) => {
  const { userId, newPass } = req.body;
  await prisma.user.update({ where: { id: userId }, data: { password: await bcrypt.hash(newPass, 10), passwordVerified: true } });
  res.json({ status: 'reset' });
};

export const manageCoinsXP = async (req: Request, res: Response) => {
  const { userId, coins, xp } = req.body;
  const update: any = {};
  if (coins !== undefined) update.coins = coins;
  if (xp !== undefined) update.xp = xp;
  await prisma.user.update({ where: { id: userId }, data: update });
  res.json({ status: 'updated' });
};

export const manageReports = async (req: Request, res: Response) => {
  const { reportId, action } = req.body;
  if (action === 'resolve') await prisma.report.update({ where: { id: reportId }, data: { status: 'RESOLVED' } });
  if (action === 'delete_target') {
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (report?.targetType === 'REEL') await prisma.reel.delete({ where: { id: report?.targetId } });
    if (report?.targetType === 'STORY') await prisma.story.delete({ where: { id: report?.targetId } });
    await prisma.report.update({ where: { id: reportId }, data: { status: 'TARGET_DELETED' } });
  }
  res.json({ status: 'handled' });
};

export const manageContent = async (req: Request, res: Response) => {
  const { type, id } = req.body;
  if (type === 'reel') await prisma.reel.delete({ where: { id } });
  if (type === 'story') await prisma.story.delete({ where: { id } });
  if (type === 'comment') await prisma.comment.delete({ where: { id } });
  if (type === 'room') await prisma.voiceRoom.update({ where: { id }, data: { isActive: false } });
  res.json({ status: 'deleted' });
};

export const setAnnouncement = async (req: Request, res: Response) => {
  const ann = await prisma.announcement.create({ data: { ...req.body, isActive: true } });
  io.emit('announcement:new', ann);
  res.json(ann);
};

export const getAnalytics = async (req: Request, res: Response) => {
  const [users, rooms, reels, reports] = await Promise.all([
    prisma.user.count(), prisma.voiceRoom.count({ where: { isActive: true } }),
    prisma.reel.count(), prisma.report.count({ where: { status: 'PENDING' } })
  ]);
  res.json({ users, activeRooms: rooms, reels, pendingReports: reports });
};
