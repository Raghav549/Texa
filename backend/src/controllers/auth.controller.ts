import { Request, Response } from 'express';

import bcrypt from 'bcrypt';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/prisma';

import {

  sendVerificationEmail,
  sendPasswordReset

} from '../services/email.service';

import { uploadFile } from '../utils/upload';

// ============================================
// HELPERS
// ============================================

const generateToken = (

  userId: string,
  role: string

) => {

  return jwt.sign(

    {

      userId,
      role,

    },

    process.env.JWT_SECRET as string,

    {

      expiresIn: '30d',

    }

  );

};

const validateEmail = (email: string) => {

  const emailRegex =

    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return emailRegex.test(email);

};

const validateUsername = (

  username: string

) => {

  const usernameRegex =

    /^[a-zA-Z0-9_]{3,20}$/;

  return usernameRegex.test(username);

};

const validatePassword = (

  password: string

) => {

  return (

    password.length >= 8 &&

    /[A-Z]/.test(password) &&

    /[a-z]/.test(password) &&

    /[0-9]/.test(password)

  );

};

// ============================================
// REGISTER
// ============================================

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

    // ============================================
    // VALIDATION
    // ============================================

    if (

      !fullName ||

      !username ||

      !email ||

      !password ||

      !dob

    ) {

      return res.status(400).json({

        success: false,

        error: 'All required fields must be provided',

      });

    }

    const normalizedEmail =

      email.toLowerCase().trim();

    const normalizedUsername =

      username.toLowerCase().trim();

    if (!validateEmail(normalizedEmail)) {

      return res.status(400).json({

        success: false,

        error: 'Invalid email format',

      });

    }

    if (

      !validateUsername(

        normalizedUsername

      )

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Username must be 3-20 characters and only contain letters, numbers, and underscores',

      });

    }

    if (!validatePassword(password)) {

      return res.status(400).json({

        success: false,

        error:
          'Password must contain uppercase, lowercase, number and minimum 8 characters',

      });

    }

    const parsedDob = new Date(dob);

    if (

      isNaN(parsedDob.getTime())

    ) {

      return res.status(400).json({

        success: false,

        error: 'Invalid date of birth',

      });

    }

    // ============================================
    // EXISTING USER CHECK
    // ============================================

    const existingUser =

      await prisma.user.findFirst({

        where: {

          OR: [

            {

              email: normalizedEmail,

            },

            {

              username:
                normalizedUsername,

            },

          ],

        },

      });

    if (existingUser) {

      return res.status(400).json({

        success: false,

        error:
          'Email or username already exists',

      });

    }

    // ============================================
    // HASH PASSWORD
    // ============================================

    const hashedPassword =

      await bcrypt.hash(

        password,
        12

      );

    // ============================================
    // AVATAR UPLOAD
    // ============================================

    let avatarUrl: string | null = null;

    if (req.file) {

      avatarUrl = await uploadFile(

        req.file,
        'avatars'

      );

    }

    // ============================================
    // CREATE USER
    // ============================================

    const user =

      await prisma.user.create({

        data: {

          fullName: fullName.trim(),

          username:
            normalizedUsername,

          email: normalizedEmail,

          phone:
            phone?.trim() || null,

          password:
            hashedPassword,

          dob: parsedDob,

          bio:
            bio?.trim() || '',

          avatarUrl,

          isVerified: false,

        },

      });

    // ============================================
    // JWT TOKEN
    // ============================================

    const token = generateToken(

      user.id,
      user.role

    );

    // ============================================
    // EMAIL VERIFICATION
    // ============================================

    try {

      const verifyToken = jwt.sign(

        {

          email: normalizedEmail,

        },

        process.env.JWT_SECRET as string,

        {

          expiresIn: '1h',

        }

      );

      await sendVerificationEmail(

        normalizedEmail,
        verifyToken

      );

    } catch (emailError) {

      console.error(

        'Verification Email Error:',
        emailError

      );

    }

    // ============================================
    // SAFE USER
    // ============================================

    const safeUser = {

      id: user.id,

      fullName: user.fullName,

      username: user.username,

      email: user.email,

      phone: user.phone,

      bio: user.bio,

      avatarUrl: user.avatarUrl,

      role: user.role,

      isVerified:
        user.isVerified,

      createdAt:
        user.createdAt,

    };

    return res.status(201).json({

      success: true,

      token,

      user: safeUser,

    });

  } catch (error) {

    console.error(

      'Register Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error: 'Registration failed',

    });

  }

};

// ============================================
// LOGIN
// ============================================

export const login = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      email,
      password

    } = req.body;

    if (

      !email ||

      !password

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Email and password are required',

      });

    }

    const normalizedEmail =

      email.toLowerCase().trim();

    const user =

      await prisma.user.findUnique({

        where: {

          email: normalizedEmail,

        },

      });

    if (!user) {

      return res.status(401).json({

        success: false,

        error:
          'Invalid credentials',

      });

    }

    const validPassword =

      await bcrypt.compare(

        password,
        user.password

      );

    if (!validPassword) {

      return res.status(401).json({

        success: false,

        error:
          'Invalid credentials',

      });

    }

    const token = generateToken(

      user.id,
      user.role

    );

    const safeUser = {

      id: user.id,

      fullName: user.fullName,

      username: user.username,

      email: user.email,

      phone: user.phone,

      bio: user.bio,

      avatarUrl: user.avatarUrl,

      role: user.role,

      isVerified:
        user.isVerified,

      createdAt:
        user.createdAt,

    };

    return res.status(200).json({

      success: true,

      token,

      user: safeUser,

    });

  } catch (error) {

    console.error(

      'Login Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error: 'Login failed',

    });

  }

};

// ============================================
// VERIFY EMAIL
// ============================================

export const verifyEmail = async (

  req: Request,
  res: Response

) => {

  try {

    const { token } = req.query;

    if (!token) {

      return res.status(400).json({

        success: false,

        error: 'Verification token missing',

      });

    }

    const decoded = jwt.verify(

      token as string,

      process.env.JWT_SECRET as string

    ) as {

      email: string;

    };

    const user =

      await prisma.user.findUnique({

        where: {

          email: decoded.email,

        },

      });

    if (!user) {

      return res.status(404).json({

        success: false,

        error: 'User not found',

      });

    }

    await prisma.user.update({

      where: {

        email: decoded.email,

      },

      data: {

        isVerified: true,

      },

    });

    return res.redirect(

      `${process.env.FRONTEND_URL}/login?verified=true`

    );

  } catch (error) {

    console.error(

      'Verify Email Error:',
      error

    );

    return res.status(400).json({

      success: false,

      error:
        'Invalid or expired verification token',

    });

  }

};

// ============================================
// FORGOT PASSWORD
// ============================================

export const forgotPassword = async (

  req: Request,
  res: Response

) => {

  try {

    const { email } = req.body;

    if (!email) {

      return res.status(400).json({

        success: false,

        error: 'Email is required',

      });

    }

    const normalizedEmail =

      email.toLowerCase().trim();

    const user =

      await prisma.user.findUnique({

        where: {

          email: normalizedEmail,

        },

      });

    if (!user) {

      return res.status(200).json({

        success: true,

        message:
          'If account exists, reset link sent.',

      });

    }

    const resetToken = jwt.sign(

      {

        email: normalizedEmail,

      },

      process.env.JWT_SECRET as string,

      {

        expiresIn: '1h',

      }

    );

    const expiresAt = new Date(

      Date.now() + 3600000

    );

    const existingToken =

      await prisma.forgotPasswordToken.findFirst({

        where: {

          email: normalizedEmail,

        },

      });

    if (existingToken) {

      await prisma.forgotPasswordToken.update({

        where: {

          id: existingToken.id,

        },

        data: {

          token: resetToken,

          expiresAt,

        },

      });

    } else {

      await prisma.forgotPasswordToken.create({

        data: {

          email: normalizedEmail,

          token: resetToken,

          expiresAt,

        },

      });

    }

    await sendPasswordReset(

      normalizedEmail,
      resetToken

    );

    return res.status(200).json({

      success: true,

      message:
        'Password reset link sent',

    });

  } catch (error) {

    console.error(

      'Forgot Password Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to process forgot password request',

    });

  }

};

// ============================================
// RESET PASSWORD
// ============================================

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

    if (

      !token ||

      !email ||

      !newPassword

    ) {

      return res.status(400).json({

        success: false,

        error:
          'All fields are required',

      });

    }

    if (

      !validatePassword(newPassword)

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Weak password format',

      });

    }

    const normalizedEmail =

      email.toLowerCase().trim();

    jwt.verify(

      token,

      process.env.JWT_SECRET as string

    );

    const record =

      await prisma.forgotPasswordToken.findFirst({

        where: {

          email: normalizedEmail,

          token,

          expiresAt: {

            gt: new Date(),

          },

        },

      });

    if (!record) {

      return res.status(400).json({

        success: false,

        error:
          'Invalid or expired reset token',

      });

    }

    const hashedPassword =

      await bcrypt.hash(

        newPassword,
        12

      );

    await prisma.user.update({

      where: {

        email: normalizedEmail,

      },

      data: {

        password:
          hashedPassword,

      },

    });

    await prisma.forgotPasswordToken.delete({

      where: {

        id: record.id,

      },

    });

    return res.status(200).json({

      success: true,

      message:
        'Password updated successfully',

    });

  } catch (error) {

    console.error(

      'Reset Password Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to reset password',

    });

  }

};
