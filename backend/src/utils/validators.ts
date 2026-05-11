import { z } from 'zod';

export const signupSchema = z.object({
  fullName: z.string().min(2).max(50),
  username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/),
  email: z.string().email(),
  password: z.string().min(8),
  dob: z.string().date(),
  bio: z.string().max(150).optional(),
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional()
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

export const tradeActionSchema = z.object({
  choiceId: z.string(),
  amount: z.number().min(10).max(5000).optional()
});

export const roomActionSchema = z.object({
  roomId: z.string(),
  action: z.enum(['mute', 'kick', 'promote', 'close', 'pause_music', 'resume_music', 'next_music']),
  targetId: z.string().optional()
});

export const messageSchema = z.object({
  receiverId: z.string(),
  content: z.string().max(5000).optional(),
  mediaUrl: z.string().url().optional()
});
