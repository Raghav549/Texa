import { Request, Response } from 'express';
import { prisma } from '../config/db';
export const createRoom = async (req: Request, res: Response) => {
  const { title } = req.body;
  const room = await prisma.voiceRoom.create({  { title, hostId: req.userId! } });
  res.json(room);
};
