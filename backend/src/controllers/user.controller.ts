import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { addXP, checkAutoVerify } from '../services/xp.service';
import { generatePrestigeData } from '../services/prestige.service';

export const getProfile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ...user, password: undefined });
};

export const follow = async (req: Request, res: Response) => {
  const { targetId } = req.params;
  const followerId = req.userId!;
  if (followerId === targetId) return res.status(400).json({ error: 'Cannot follow yourself' });
  await prisma.$transaction([
    prisma.user.update({ where: { id: targetId },  { followers: { push: followerId } } }),
    prisma.user.update({ where: { id: followerId },  { following: { push: targetId } } })
  ]);
  await checkAutoVerify(targetId);
  res.json({ status: 'ok' });
};

export const getPrestige = async (req: Request, res: Response) => {
  try {
    const data = await generatePrestigeData(req.userId!);
    res.json(data);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

export const createStory = async (req: Request, res: Response) => {
  const { caption } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Media required' });
  const url = req.file.mimetype.startsWith('image/') ? await uploadToS3(req.file, 'stories/img') : await uploadToS3(req.file, 'stories/video');
  await prisma.story.create({ data: { userId: req.userId!, mediaUrl: url, caption } });
  await addXP(req.userId!, 3);
  res.status(201).json({ status: 'uploaded' });
};
