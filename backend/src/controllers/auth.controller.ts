import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../config/db';
import { sendVerificationEmail, sendPasswordReset } from '../services/email.service';
import { uploadFile } from '../utils/upload';

type AuthTokenPayload = {
  userId: string;
  role: UserRole;
  purpose: 'auth';
};

type EmailVerifyPayload = {
  userId: string;
  email: string;
  purpose: 'email_verify';
};

type PasswordResetPayload = {
  userId: string;
  email: string;
  purpose: 'password_reset';
};

const isProduction = process.env.NODE_ENV === 'production';

const userSelect = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  phone: true,
  dob: true,
  bio: true,
  avatarUrl: true,
  coverUrl: true,
  role: true,
  isVerified: true,
  isBanned: true,
  banReason: true,
  coins: true,
  xp: true,
  level: true,
  trustScore: true,
  theme: true,
  accentColor: true,
  notificationSettings: true,
  privacySettings: true,
  safetySettings: true,
  displaySettings: true,
  lastLogin: true,
  loginStreak: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

const normalizeText = (value: unknown) => String(value ?? '').trim();

const normalizeEmail = (value: unknown) => normalizeText(value).toLowerCase();

const normalizeUsername = (value: unknown) => normalizeText(value).toLowerCase();

const normalizePhone = (value: unknown) => {
  const phone = normalizeText(value);
  return phone || null;
};

const getJwtSecret = (): Secret => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is missing');
  }

  return secret;
};

const getFrontendUrl = () => {
  return process.env.FRONTEND_URL || process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173';
};

const sendSuccess = (res: Response, status: number, data: Record<string, unknown> = {}) => {
  return res.status(status).json({
    success: true,
    ok: true,
    ...data
  });
};

const sendError = (
  res: Response,
  status: number,
  error: string,
  code = 'REQUEST_FAILED',
  extra: Record<string, unknown> = {}
) => {
  return res.status(status).json({
    success: false,
    ok: false,
    error,
    code,
    ...extra
  });
};

const logError = (label: string, error: unknown) => {
  const err = error as Error;
  console.error(
    JSON.stringify(
      {
        level: 'error',
        label,
        message: err?.message || String(error),
        stack: isProduction ? undefined : err?.stack,
        timestamp: new Date().toISOString()
      },
      null,
      2
    )
  );
};

const validateEmail = (email: string) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validateUsername = (username: string) => {
  return /^[a-zA-Z0-9_]{3,30}$/.test(username);
};

const validatePassword = (password: string) => {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
};

const validateDob = (value: unknown) => {
  if (!value) return null;

  const date = new Date(String(value));

  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();

  if (date > now) return null;

  return date;
};

const generateToken = (userId: string, role: UserRole) => {
  const options: SignOptions = {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-client'
  };

  return jwt.sign(
    {
      userId,
      role,
      purpose: 'auth'
    } satisfies AuthTokenPayload,
    getJwtSecret(),
    options
  );
};

const generateEmailVerificationToken = (userId: string, email: string) => {
  const options: SignOptions = {
    expiresIn: process.env.EMAIL_VERIFY_EXPIRES_IN || '1h',
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-client'
  };

  return jwt.sign(
    {
      userId,
      email,
      purpose: 'email_verify'
    } satisfies EmailVerifyPayload,
    getJwtSecret(),
    options
  );
};

const generatePasswordResetToken = (userId: string, email: string) => {
  const options: SignOptions = {
    expiresIn: process.env.PASSWORD_RESET_EXPIRES_IN || '1h',
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-client'
  };

  return jwt.sign(
    {
      userId,
      email,
      purpose: 'password_reset'
    } satisfies PasswordResetPayload,
    getJwtSecret(),
    options
  );
};

const verifyJwt = <T>(token: string) => {
  return jwt.verify(token, getJwtSecret(), {
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-client'
  }) as T;
};

const buildSafeUser = (user: Prisma.UserGetPayload<{ select: typeof userSelect }>) => {
  return {
    id: user.id,
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    phone: user.phone,
    dob: user.dob,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    role: user.role,
    isVerified: user.isVerified,
    isBanned: user.isBanned,
    banReason: user.banReason,
    coins: user.coins,
    xp: user.xp,
    level: user.level,
    trustScore: user.trustScore,
    theme: user.theme,
    accentColor: user.accentColor,
    notificationSettings: user.notificationSettings,
    privacySettings: user.privacySettings,
    safetySettings: user.safetySettings,
    displaySettings: user.displaySettings,
    lastLogin: user.lastLogin,
    loginStreak: user.loginStreak,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

const calculateLoginStreak = (lastLogin: Date | null, currentStreak: number) => {
  if (!lastLogin) return 1;

  const now = new Date();
  const last = new Date(lastLogin);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const lastDay = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();

  const diffDays = Math.floor((today - lastDay) / 86400000);

  if (diffDays === 0) return currentStreak;
  if (diffDays === 1) return currentStreak + 1;

  return 1;
};

export const register = async (req: Request, res: Response) => {
  try {
    const fullName = normalizeText(req.body.fullName);
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password ?? '');
    const phone = normalizePhone(req.body.phone);
    const bio = normalizeText(req.body.bio);
    const dob = validateDob(req.body.dob);

    if (!fullName || !username || !email || !password || !dob) {
      return sendError(res, 400, 'All required fields must be provided', 'MISSING_REQUIRED_FIELDS');
    }

    if (fullName.length < 2 || fullName.length > 80) {
      return sendError(res, 400, 'Full name must be between 2 and 80 characters', 'INVALID_FULL_NAME');
    }

    if (!validateEmail(email)) {
      return sendError(res, 400, 'Invalid email format', 'INVALID_EMAIL');
    }

    if (!validateUsername(username)) {
      return sendError(
        res,
        400,
        'Username must be 3-30 characters and only contain letters, numbers, and underscores',
        'INVALID_USERNAME'
      );
    }

    if (!validatePassword(password)) {
      return sendError(
        res,
        400,
        'Password must contain uppercase, lowercase, number and minimum 8 characters',
        'WEAK_PASSWORD'
      );
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username },
          ...(phone ? [{ phone }] : [])
        ]
      },
      select: {
        id: true,
        email: true,
        username: true,
        phone: true
      }
    });

    if (existingUser?.email === email) {
      return sendError(res, 409, 'Email already exists', 'EMAIL_EXISTS');
    }

    if (existingUser?.username === username) {
      return sendError(res, 409, 'Username already exists', 'USERNAME_EXISTS');
    }

    if (phone && existingUser?.phone === phone) {
      return sendError(res, 409, 'Phone already exists', 'PHONE_EXISTS');
    }

    const hashedPassword = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));

    let avatarUrl: string | null = null;

    if (req.file) {
      avatarUrl = await uploadFile(req.file, 'avatars');
    }

    const user = await prisma.user.create({
      data: {
        fullName,
        username,
        email,
        phone,
        password: hashedPassword,
        dob,
        bio,
        avatarUrl,
        role: UserRole.USER,
        isVerified: false,
        isBanned: false,
        lastLogin: new Date(),
        loginStreak: 1,
        notificationSettings: {},
        privacySettings: {},
        safetySettings: {},
        displaySettings: {}
      },
      select: userSelect
    });

    const token = generateToken(user.id, user.role);

    try {
      const verifyToken = generateEmailVerificationToken(user.id, user.email);
      await sendVerificationEmail(user.email, verifyToken);
    } catch (emailError) {
      logError('VERIFICATION_EMAIL_FAILED', emailError);
    }

    return sendSuccess(res, 201, {
      token,
      user: buildSafeUser(user)
    });
  } catch (error: any) {
    logError('REGISTER_FAILED', error);

    if (error?.code === 'P2002') {
      return sendError(res, 409, 'Account with same unique field already exists', 'UNIQUE_CONSTRAINT_FAILED');
    }

    return sendError(res, 500, 'Registration failed', 'REGISTER_FAILED');
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password ?? '');

    if (!email || !password) {
      return sendError(res, 400, 'Email and password are required', 'MISSING_CREDENTIALS');
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return sendError(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Account is banned', 'ACCOUNT_BANNED', {
        banReason: user.banReason
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return sendError(res, 401, 'Invalid credentials', 'INVALID_CREDENTIALS');
    }

    const nextLoginStreak = calculateLoginStreak(user.lastLogin, user.loginStreak);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: new Date(),
        loginStreak: nextLoginStreak
      },
      select: userSelect
    });

    const token = generateToken(updatedUser.id, updatedUser.role);

    return sendSuccess(res, 200, {
      token,
      user: buildSafeUser(updatedUser)
    });
  } catch (error) {
    logError('LOGIN_FAILED', error);
    return sendError(res, 500, 'Login failed', 'LOGIN_FAILED');
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const token = normalizeText(req.query.token);

    if (!token) {
      return sendError(res, 400, 'Verification token missing', 'TOKEN_MISSING');
    }

    const decoded = verifyJwt<EmailVerifyPayload>(token);

    if (decoded.purpose !== 'email_verify' || !decoded.userId || !decoded.email) {
      return sendError(res, 400, 'Invalid verification token', 'INVALID_TOKEN');
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        isVerified: true
      }
    });

    if (!user || user.email !== decoded.email) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (!user.isVerified) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          isVerified: true
        }
      });
    }

    const redirectUrl = `${getFrontendUrl().replace(/\/$/, '')}/login?verified=true`;

    return res.redirect(redirectUrl);
  } catch (error) {
    logError('VERIFY_EMAIL_FAILED', error);
    return sendError(res, 400, 'Invalid or expired verification token', 'INVALID_OR_EXPIRED_TOKEN');
  }
};

export const resendVerificationEmail = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return sendError(res, 400, 'Email is required', 'EMAIL_REQUIRED');
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        isVerified: true,
        isBanned: true
      }
    });

    if (!user) {
      return sendSuccess(res, 200, {
        message: 'If account exists, verification link sent.'
      });
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Account is banned', 'ACCOUNT_BANNED');
    }

    if (user.isVerified) {
      return sendSuccess(res, 200, {
        message: 'Email is already verified.'
      });
    }

    const verifyToken = generateEmailVerificationToken(user.id, user.email);
    await sendVerificationEmail(user.email, verifyToken);

    return sendSuccess(res, 200, {
      message: 'Verification link sent.'
    });
  } catch (error) {
    logError('RESEND_VERIFICATION_EMAIL_FAILED', error);
    return sendError(res, 500, 'Failed to resend verification email', 'RESEND_VERIFICATION_FAILED');
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return sendError(res, 400, 'Email is required', 'EMAIL_REQUIRED');
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        isBanned: true
      }
    });

    if (!user || user.isBanned) {
      return sendSuccess(res, 200, {
        message: 'If account exists, reset link sent.'
      });
    }

    const resetToken = generatePasswordResetToken(user.id, user.email);

    await sendPasswordReset(user.email, resetToken);

    return sendSuccess(res, 200, {
      message: 'If account exists, reset link sent.'
    });
  } catch (error) {
    logError('FORGOT_PASSWORD_FAILED', error);
    return sendError(res, 500, 'Failed to process forgot password request', 'FORGOT_PASSWORD_FAILED');
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const token = normalizeText(req.body.token);
    const email = normalizeEmail(req.body.email);
    const newPassword = String(req.body.newPassword ?? '');

    if (!token || !email || !newPassword) {
      return sendError(res, 400, 'All fields are required', 'MISSING_RESET_FIELDS');
    }

    if (!validatePassword(newPassword)) {
      return sendError(res, 400, 'Weak password format', 'WEAK_PASSWORD');
    }

    const decoded = verifyJwt<PasswordResetPayload>(token);

    if (decoded.purpose !== 'password_reset' || !decoded.userId || !decoded.email) {
      return sendError(res, 400, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN');
    }

    if (decoded.email !== email) {
      return sendError(res, 400, 'Invalid reset token email', 'RESET_EMAIL_MISMATCH');
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        isBanned: true
      }
    });

    if (!user || user.email !== email) {
      return sendError(res, 400, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Account is banned', 'ACCOUNT_BANNED');
    }

    const hashedPassword = await bcrypt.hash(newPassword, Number(process.env.BCRYPT_ROUNDS || 12));

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        backupCodes: []
      }
    });

    return sendSuccess(res, 200, {
      message: 'Password updated successfully'
    });
  } catch (error) {
    logError('RESET_PASSWORD_FAILED', error);
    return sendError(res, 400, 'Invalid or expired reset token', 'RESET_PASSWORD_FAILED');
  }
};

export const me = async (req: Request, res: Response) => {
  try {
    const userId =
      typeof (req as any).userId === 'string'
        ? (req as any).userId
        : typeof (req as any).user?.id === 'string'
          ? (req as any).user.id
          : typeof (req as any).auth?.userId === 'string'
            ? (req as any).auth.userId
            : '';

    if (!userId) {
      return sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: userSelect
    });

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Account is banned', 'ACCOUNT_BANNED', {
        banReason: user.banReason
      });
    }

    return sendSuccess(res, 200, {
      user: buildSafeUser(user)
    });
  } catch (error) {
    logError('ME_FAILED', error);
    return sendError(res, 500, 'Failed to fetch profile', 'ME_FAILED');
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  try {
    const rawToken =
      normalizeText(req.body.token) ||
      normalizeText(req.headers.authorization).replace(/^Bearer\s+/i, '');

    if (!rawToken) {
      return sendError(res, 400, 'Token is required', 'TOKEN_REQUIRED');
    }

    const decoded = verifyJwt<AuthTokenPayload>(rawToken);

    if (decoded.purpose !== 'auth' || !decoded.userId) {
      return sendError(res, 401, 'Invalid token', 'INVALID_TOKEN');
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: userSelect
    });

    if (!user) {
      return sendError(res, 404, 'User not found', 'USER_NOT_FOUND');
    }

    if (user.isBanned) {
      return sendError(res, 403, 'Account is banned', 'ACCOUNT_BANNED', {
        banReason: user.banReason
      });
    }

    const token = generateToken(user.id, user.role);

    return sendSuccess(res, 200, {
      token,
      user: buildSafeUser(user)
    });
  } catch (error) {
    logError('REFRESH_TOKEN_FAILED', error);
    return sendError(res, 401, 'Invalid or expired token', 'REFRESH_TOKEN_FAILED');
  }
};

export const logout = async (_req: Request, res: Response) => {
  return sendSuccess(res, 200, {
    message: 'Logged out successfully'
  });
};
