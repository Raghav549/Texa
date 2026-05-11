import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadFile } from '../utils/upload';
import { addXP } from '../services/xp.service';

export const createStory = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Media required' });
    const url = await uploadFile(req.file, 'stories');
    const { caption, musicTrack, stickers } = req.body;
    const story = await prisma.story.create({
       { userId: req.userId!, mediaUrl: url, caption, musicTrack, stickers: JSON.parse(stickers || '{}') }
    });
    await addXP(req.userId!, 5);
    res.status(201).json(story);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const getStories = async (req: Request, res: Response) => {
  const stories = await prisma.story.findMany({ where: { expiresAt: { gt: new Date() }, NOT: { userId: req.userId! } }, include: { author: { select: { username: true, isVerified: true, avatarUrl: true } } } });
  res.json(stories);
};

export const viewStory = async (req: Request, res: Response) => {
  await prisma.story.update({ where: { id: req.params.id }, data: { viewers: { push: req.userId! } } });
  res.json({ status: 'viewed' });
};

export const reactStory = async (req: Request, res: Response) => {
  const { emoji } = req.body;
  const story = await prisma.story.findUnique({ where: { id: req.params.id } });
  const reactions = story?.reactions as any || {};
  reactions[emoji] = (reactions[emoji] || 0) + 1;
  await prisma.story.update({ where: { id: req.params.id },  { reactions } });
  res.json({ status: 'reacted' });
};
