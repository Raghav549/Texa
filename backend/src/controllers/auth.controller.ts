import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { sendVerificationEmail, sendPasswordReset } from '../services/email.service';
import { uploadFile } from '../utils/upload';

export const register = async (req: Request, res: Response) => {
  const { fullName, username, email, password, dob, bio, phone } = req.body;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username: username.toLowerCase() }] } });
  if (existing) return res.status(400).json({ error: 'Email or username already exists' });
  const hashed = await bcrypt.hash(password, 10);
  const avatarUrl = req.file ? await uploadFile(req.file, 'avatars') : null;
  const isKashyap = username.toLowerCase() === 'kashyap' && fullName === 'Texa';
  const user = await prisma.user.create({
    data: { fullName, username: username.toLowerCase(), email, phone, password: hashed, dob: new Date(dob), bio, avatarUrl, isVerified: isKashyap }
  });
  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '30d' });
  // Send verification email in background
  sendVerificationEmail(email, jwt.sign({ email }, process.env.JWT_SECRET!, { expiresIn: '1h' })).catch(console.error);
  res.status(201).json({ token, user: { ...user, password: undefined } });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.emailVerified) return res.status(403).json({ error: 'Verify your email first' });
  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '30d' });
  res.json({ token, user: { ...user, password: undefined } });
};

export const verifyEmail = async (req: Request, res: Response) => {
  const { token } = req.query;
  try {
    const { email } = jwt.verify(token as string, process.env.JWT_SECRET!) as { email: string };
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    res.redirect(`${process.env.FRONTEND_URL}/login?verified=true`);
  } catch { res.status(400).json({ error: 'Invalid or expired token' }); }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(200).json({ message: 'If account exists, reset link sent.' });
  const token = jwt.sign({ email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  await prisma.forgotPasswordToken.upsert({ where: { email }, update: { token, expiresAt: new Date(Date.now() + 3600000) }, create: { email, token, expiresAt: new Date(Date.now() + 3600000) } });
  await sendPasswordReset(email, token);
  res.json({ message: 'Reset link sent' });
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, email, newPassword } = req.body;
  const record = await prisma.forgotPasswordToken.findFirst({ where: { email, token, expiresAt: { gt: new Date() } } });
  if (!record) return res.status(400).json({ error: 'Invalid or expired reset link' });
  await prisma.user.update({ where: { email }, data: { password: await bcrypt.hash(newPassword, 10) } });
  await prisma.forgotPasswordToken.delete({ where: { id: record.id } });
  res.json({ message: 'Password updated' });
};
