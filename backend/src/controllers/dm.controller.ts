import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadFile } from '../utils/upload';
import { io } from '../app';

export const sendMessage = async (req: Request, res: Response) => {
  const { receiverId, content } = req.body;
  let mediaUrl: string | undefined;
  if (req.file) mediaUrl = await uploadFile(req.file, 'dm_media');
  const msg = await prisma.message.create({ data: { senderId: req.userId!, receiverId, content, mediaUrl } });
  io.to(`dm:${receiverId}`).emit('dm:new', msg);
  res.json(msg);
};

export const getConversation = async (req: Request, res: Response) => {
  const msgs = await prisma.message.findMany({ where: { OR: [{ senderId: req.userId!, receiverId: req.params.userId }, { senderId: req.params.userId, receiverId: req.userId! }] }, orderBy: { createdAt: 'asc' } });
  res.json(msgs);
};

export const markSeen = async (req: Request, res: Response) => {
  const { messageId, senderId } = req.body;
  await prisma.message.update({ where: { id: messageId },  { status: 'SEEN' } });
  io.to(`dm:${senderId}`).emit('dm:seen', messageId);
  res.json({ status: 'seen' });
};
