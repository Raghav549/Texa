import { Request, Response } from 'express';

import bcrypt from 'bcrypt';

import jwt from 'jsonwebtoken';

import { prisma } from '../config/prisma';

import { io } from '../app';

import { Role } from '@prisma/client';

// ============================================
// HELPERS
// ============================================

const generateAdminToken = (

  userId: string,
  role: Role

) => {

  return jwt.sign(

    {

      userId,
      role,

    },

    process.env.JWT_SECRET as string,

    {

      expiresIn: '12h',

    }

  );

};

// ============================================
// ADMIN LOGIN
// ============================================

export const adminLogin = async (

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

    if (

      !user ||

      !['ADMIN', 'SUPERADMIN'].includes(

        user.role

      )

    ) {

      return res.status(403).json({

        success: false,

        error: 'Unauthorized access',

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
          'Invalid admin credentials',

      });

    }

    const token = generateAdminToken(

      user.id,
      user.role

    );

    return res.status(200).json({

      success: true,

      token,

      admin: {

        id: user.id,

        fullName: user.fullName,

        username: user.username,

        email: user.email,

        role: user.role,

        avatarUrl: user.avatarUrl,

      },

    });

  } catch (error) {

    console.error(

      'Admin Login Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error: 'Admin login failed',

    });

  }

};

// ============================================
// LIST USERS
// ============================================

export const listUsers = async (

  req: Request,
  res: Response

) => {

  try {

    const users =

      await prisma.user.findMany({

        orderBy: {

          createdAt: 'desc',

        },

        select: {

          id: true,

          username: true,

          fullName: true,

          email: true,

          phone: true,

          avatarUrl: true,

          coins: true,

          xp: true,

          level: true,

          isVerified: true,

          role: true,

          followers: true,

          following: true,

          createdAt: true,

        },

      });

    return res.status(200).json({

      success: true,

      users,

    });

  } catch (error) {

    console.error(

      'List Users Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error: 'Failed to fetch users',

    });

  }

};

// ============================================
// MANAGE USER
// ============================================

export const manageUser = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      userId,
      action

    } = req.body;

    if (

      !userId ||

      !action

    ) {

      return res.status(400).json({

        success: false,

        error:
          'User ID and action are required',

      });

    }

    const user =

      await prisma.user.findUnique({

        where: {

          id: userId,

        },

      });

    if (!user) {

      return res.status(404).json({

        success: false,

        error: 'User not found',

      });

    }

    // ============================================
    // DELETE USER
    // ============================================

    if (action === 'delete') {

      await prisma.user.delete({

        where: {

          id: userId,

        },

      });

    }

    // ============================================
    // VERIFY USER
    // ============================================

    if (action === 'verify') {

      await prisma.user.update({

        where: {

          id: userId,

        },

        data: {

          isVerified: true,

        },

      });

    }

    // ============================================
    // UNVERIFY USER
    // ============================================

    if (action === 'unverify') {

      await prisma.user.update({

        where: {

          id: userId,

        },

        data: {

          isVerified: false,

        },

      });

    }

    io.emit(

      'admin:userUpdated',

      {

        userId,
        action,

      }

    );

    return res.status(200).json({

      success: true,

      status: 'updated',

    });

  } catch (error) {

    console.error(

      'Manage User Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error: 'Failed to manage user',

    });

  }

};

// ============================================
// TOGGLE VERIFY
// ============================================

export const toggleVerify = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      userId,
      verify

    } = req.body;

    if (

      !userId ||

      typeof verify !== 'boolean'

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Invalid verification request',

      });

    }

    const updatedUser =

      await prisma.user.update({

        where: {

          id: userId,

        },

        data: {

          isVerified: verify,

        },

      });

    io.emit(

      'admin:verifyUpdated',

      {

        userId,
        verify,

      }

    );

    return res.status(200).json({

      success: true,

      status:
        verify
          ? 'verified'
          : 'unverified',

      user: {

        id: updatedUser.id,

        isVerified:
          updatedUser.isVerified,

      },

    });

  } catch (error) {

    console.error(

      'Toggle Verify Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to update verification',

    });

  }

};

// ============================================
// RESET USER PASSWORD
// ============================================

export const resetUserPass = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      userId,
      newPass

    } = req.body;

    if (

      !userId ||

      !newPass

    ) {

      return res.status(400).json({

        success: false,

        error:
          'User ID and new password are required',

      });

    }

    if (newPass.length < 8) {

      return res.status(400).json({

        success: false,

        error:
          'Password must be at least 8 characters',

      });

    }

    const hashedPassword =

      await bcrypt.hash(

        newPass,
        12

      );

    await prisma.user.update({

      where: {

        id: userId,

      },

      data: {

        password:
          hashedPassword,

      },

    });

    return res.status(200).json({

      success: true,

      status: 'password_reset',

    });

  } catch (error) {

    console.error(

      'Reset User Password Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to reset password',

    });

  }

};

// ============================================
// MANAGE COINS & XP
// ============================================

export const manageCoinsXP = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      userId,
      coins,
      xp

    } = req.body;

    if (!userId) {

      return res.status(400).json({

        success: false,

        error: 'User ID required',

      });

    }

    const updateData: {

      coins?: number;
      xp?: number;

    } = {};

    if (

      coins !== undefined

    ) {

      updateData.coins = Number(coins);

    }

    if (

      xp !== undefined

    ) {

      updateData.xp = Number(xp);

    }

    await prisma.user.update({

      where: {

        id: userId,

      },

      data: updateData,

    });

    return res.status(200).json({

      success: true,

      status: 'updated',

    });

  } catch (error) {

    console.error(

      'Manage Coins XP Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to update coins/xp',

    });

  }

};

// ============================================
// MANAGE REPORTS
// ============================================

export const manageReports = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      reportId,
      action

    } = req.body;

    if (

      !reportId ||

      !action

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Report ID and action required',

      });

    }

    const report =

      await prisma.report.findUnique({

        where: {

          id: reportId,

        },

      });

    if (!report) {

      return res.status(404).json({

        success: false,

        error: 'Report not found',

      });

    }

    if (action === 'resolve') {

      await prisma.report.update({

        where: {

          id: reportId,

        },

        data: {

          status: 'RESOLVED',

        },

      });

    }

    if (action === 'delete_target') {

      await prisma.report.update({

        where: {

          id: reportId,

        },

        data: {

          status:
            'TARGET_DELETED',

        },

      });

    }

    return res.status(200).json({

      success: true,

      status: 'handled',

    });

  } catch (error) {

    console.error(

      'Manage Reports Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to manage reports',

    });

  }

};

// ============================================
// MANAGE CONTENT
// ============================================

export const manageContent = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      type,
      id

    } = req.body;

    if (

      !type ||

      !id

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Content type and ID required',

      });

    }

    if (type === 'reel') {

      await prisma.reel.delete({

        where: {

          id,

        },

      });

    }

    if (type === 'story') {

      await prisma.story.delete({

        where: {

          id,

        },

      });

    }

    if (type === 'comment') {

      await prisma.comment.delete({

        where: {

          id,

        },

      });

    }

    if (type === 'room') {

      await prisma.voiceRoom.update({

        where: {

          id,

        },

        data: {

          isActive: false,

        },

      });

    }

    return res.status(200).json({

      success: true,

      status: 'content_managed',

    });

  } catch (error) {

    console.error(

      'Manage Content Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to manage content',

    });

  }

};

// ============================================
// CREATE ANNOUNCEMENT
// ============================================

export const setAnnouncement = async (

  req: Request,
  res: Response

) => {

  try {

    const {

      title,
      content

    } = req.body;

    if (

      !title ||

      !content

    ) {

      return res.status(400).json({

        success: false,

        error:
          'Title and content required',

      });

    }

    const announcement =

      await prisma.announcement.create({

        data: {

          title:
            title.trim(),

          content:
            content.trim(),

          isActive: true,

        },

      });

    io.emit(

      'announcement:new',

      announcement

    );

    return res.status(201).json({

      success: true,

      announcement,

    });

  } catch (error) {

    console.error(

      'Set Announcement Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to create announcement',

    });

  }

};

// ============================================
// GET ANALYTICS
// ============================================

export const getAnalytics = async (

  req: Request,
  res: Response

) => {

  try {

    const [

      totalUsers,
      activeRooms,
      totalReels,
      pendingReports

    ] = await Promise.all([

      prisma.user.count(),

      prisma.voiceRoom.count({

        where: {

          isActive: true,

        },

      }),

      prisma.reel.count(),

      prisma.report.count({

        where: {

          status: 'PENDING',

        },

      }),

    ]);

    return res.status(200).json({

      success: true,

      analytics: {

        totalUsers,

        activeRooms,

        totalReels,

        pendingReports,

      },

    });

  } catch (error) {

    console.error(

      'Get Analytics Error:',
      error

    );

    return res.status(500).json({

      success: false,

      error:
        'Failed to fetch analytics',

    });

  }

};
