import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { KASHYAP_CHECK } from '../services/verification.service';
import { uploadToS3 } from '../utils/upload'; // assumed helper

export const register = async (req: Request, res: Response) => {
  try {
    const { fullName, username, email, password, dob, bio, phone } = req.body;
    const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
    if (existing) return res.status(400).json({ error: 'Email or username taken' });
    const hashed = await bcrypt.hash(password, 10);
    let avatarUrl = req.file ? await uploadToS3(req.file, 'avatars') : null;
    const user = await prisma.user.create({
       { fullName, username: username.toLowerCase(), email, phone, password: hashed, dob: new Date(dob), bio, avatarUrl,
        isVerified: username.toLowerCase() === KASHYAP_CHECK.username.toLowerCase() }
    });
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '30d' });
    res.status(201).json({ token, user: { ...user, password: undefined } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '30d' });
    res.json({ token, user: { ...user, password: undefined } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
};
