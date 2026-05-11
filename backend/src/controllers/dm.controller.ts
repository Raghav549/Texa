import { Request, Response } from 'express';
import { prisma } from '../config/db';
export const sendMessage = async (req: Request, res: Response) => {
  const { receiverId, content, mediaUrl } = req.body;
  const msg = await prisma.message.create({ data: { senderId: req.userId!, receiverId, content, mediaUrl } });
  res.json(msg);
};
