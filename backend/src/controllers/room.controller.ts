import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadFile } from '../utils/upload';
import { io } from '../app';

export const createRoom = async (req: Request, res: Response) => {
  const { title } = req.body;
  let coverUrl: string | undefined;
  if (req.file) coverUrl = await uploadFile(req.file, 'rooms');
  const room = await prisma.voiceRoom.create({ data: { title, coverUrl, hostId: req.userId! } });
  res.status(201).json(room);
};

export const getActiveRooms = async (req: Request, res: Response) => {
  const rooms = await prisma.voiceRoom.findMany({ where: { isActive: true }, include: { host: { select: { username: true, isVerified: true } }, _count: { select: { seats: true } } } });
  res.json(rooms);
};

export const hostControl = async (req: Request, res: Response) => {
  const { action, targetUserId } = req.body;
  const room = await prisma.voiceRoom.findUnique({ where: { id: req.params.id }, include: { host: true } });
  if (!room || room.hostId !== req.userId!) return res.status(403).json({ error: 'Host only' });
  if (action === 'mute') {
    await prisma.seat.updateMany({ where: { roomId: room.id, userId: targetUserId },  { isMuted: true } });
    io.to(room.id).emit('seat:mute', { userId: targetUserId, muted: true });
  } else if (action === 'kick') {
    await prisma.seat.deleteMany({ where: { roomId: room.id, userId: targetUserId } });
    io.to(room.id).emit('seat:kicked', { userId: targetUserId });
  }
  res.json({ status: 'executed' });
};
