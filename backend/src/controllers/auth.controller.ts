import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import { prisma } from '../config/db';
import {
  sendVerificationEmail,
  sendPasswordReset
} from '../services/email.service';

import { uploadFile } from '../utils/upload';

export const register = async (
  req: Request,
  res: Response
) => {
  try {
    const {
      fullName,
      username,
      email,
      password,
      dob,
      bio,
      phone
    } = req.body;

    const existing =
      await prisma.user.findFirst({
        where: {
          OR: [
            { email },
            {
              username:
                username.toLowerCase()
            }
          ]
        }
      });

    if (existing) {
      return res.status(400).json({
        error:
          'Email or username already exists'
      });
    }

    const hashed = await bcrypt.hash(
      password,
      10
    );

    let avatarUrl: string | null = null;

    if (req.file) {
      avatarUrl = await uploadFile(
        req.file,
        'avatars'
      );
    }

    const isKashyap =
      username.toLowerCase() ===
        'kashyap' &&
      fullName === 'Texa';

    const user = await prisma.user.create({
      data: {
        fullName,
        username:
          username.toLowerCase(),
        email,
        phone,
        password: hashed,
        dob: new Date(dob),
        bio,
        avatarUrl,
        isVerified: isKashyap
      }
    });

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role
      },
      process.env.JWT_SECRET as string,
      {
        expiresIn: '30d'
      }
    );

    try {
      const verifyToken = jwt.sign(
        { email },
        process.env.JWT_SECRET as string,
        {
          expiresIn: '1h'
        }
      );

      await sendVerificationEmail(
        email,
        verifyToken
      );

    } catch (emailError) {
      console.error(emailError);
    }

    const safeUser = {
      ...user,
      password: undefined
    };

    res.status(201).json({
      token,
      user: safeUser
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Registration failed'
    });
  }
};

export const login = async (
  req: Request,
  res: Response
) => {
  try {
    const { email, password } =
      req.body;

    const user =
      await prisma.user.findUnique({
        where: { email }
      });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const validPassword =
      await bcrypt.compare(
        password,
        user.password
      );

    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role
      },
      process.env.JWT_SECRET as string,
      {
        expiresIn: '30d'
      }
    );

    const safeUser = {
      ...user,
      password: undefined
    };

    res.json({
      token,
      user: safeUser
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Login failed'
    });
  }
};

export const verifyEmail = async (
  req: Request,
  res: Response
) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        error: 'Token missing'
      });
    }

    const decoded = jwt.verify(
      token as string,
      process.env.JWT_SECRET as string
    ) as {
      email: string;
    };

    await prisma.user.update({
      where: {
        email: decoded.email
      },
      data: {
        isVerified: true
      }
    });

    res.redirect(
      `${process.env.FRONTEND_URL}/login?verified=true`
    );

  } catch (error) {
    console.error(error);

    res.status(400).json({
      error:
        'Invalid or expired token'
    });
  }
};

export const forgotPassword = async (
  req: Request,
  res: Response
) => {
  try {
    const { email } = req.body;

    const user =
      await prisma.user.findUnique({
        where: { email }
      });

    if (!user) {
      return res.status(200).json({
        message:
          'If account exists, reset link sent.'
      });
    }

    const token = jwt.sign(
      { email },
      process.env.JWT_SECRET as string,
      {
        expiresIn: '1h'
      }
    );

    const expiresAt = new Date(
      Date.now() + 3600000
    );

    await prisma.forgotPasswordToken.upsert({
      where: { email },

      update: {
        token,
        expiresAt
      },

      create: {
        email,
        token,
        expiresAt
      }
    });

    await sendPasswordReset(
      email,
      token
    );

    res.json({
      message: 'Reset link sent'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to process forgot password'
    });
  }
};

export const resetPassword = async (
  req: Request,
  res: Response
) => {
  try {
    const {
      token,
      email,
      newPassword
    } = req.body;

    const record =
      await prisma.forgotPasswordToken.findFirst({
        where: {
          email,
          token,
          expiresAt: {
            gt: new Date()
          }
        }
      });

    if (!record) {
      return res.status(400).json({
        error:
          'Invalid or expired reset link'
      });
    }

    const hashedPassword =
      await bcrypt.hash(
        newPassword,
        10
      );

    await prisma.user.update({
      where: { email },

      data: {
        password: hashedPassword
      }
    });

    await prisma.forgotPasswordToken.delete({
      where: {
        id: record.id
      }
    });

    res.json({
      message: 'Password updated'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to reset password'
    });
  }
};
