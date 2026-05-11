import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

export const adminLogin = async (
  req: Request,
  res: Response
) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (
      !user ||
      !['ADMIN', 'SUPERADMIN'].includes(user.role)
    ) {
      return res.status(403).json({
        error: 'Unauthorized'
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password
    );

    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid admin credentials'
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role
      },
      process.env.JWT_SECRET as string,
      {
        expiresIn: '12h'
      }
    );

    res.json({ token });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Admin login failed'
    });
  }
};

export const listUsers = async (
  req: Request,
  res: Response
) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        coins: true,
        xp: true,
        level: true,
        isVerified: true,
        role: true,
        followers: true,
        createdAt: true
      }
    });

    res.json(users);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to fetch users'
    });
  }
};

export const manageUser = async (
  req: Request,
  res: Response
) => {
  try {
    const { userId, action } = req.body;

    if (action === 'delete') {
      await prisma.user.delete({
        where: { id: userId }
      });
    }

    io.emit('admin:userUpdated', {
      userId,
      action
    });

    res.json({
      status: 'ok'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to manage user'
    });
  }
};

export const toggleVerify = async (
  req: Request,
  res: Response
) => {
  try {
    const { userId, verify } = req.body;

    await prisma.user.update({
      where: { id: userId },
      data: {
        isVerified: verify
      }
    });

    io.emit('admin:verifyUpdated', {
      userId,
      verify
    });

    res.json({
      status: verify
        ? 'verified'
        : 'unverified'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to update verification'
    });
  }
};

export const resetUserPass = async (
  req: Request,
  res: Response
) => {
  try {
    const { userId, newPass } = req.body;

    const hashedPassword = await bcrypt.hash(
      newPass,
      10
    );

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword
      }
    });

    res.json({
      status: 'reset'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Password reset failed'
    });
  }
};

export const manageCoinsXP = async (
  req: Request,
  res: Response
) => {
  try {
    const { userId, coins, xp } = req.body;

    const update: any = {};

    if (coins !== undefined) {
      update.coins = coins;
    }

    if (xp !== undefined) {
      update.xp = xp;
    }

    await prisma.user.update({
      where: { id: userId },
      data: update
    });

    res.json({
      status: 'updated'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to update coins/xp'
    });
  }
};

export const manageReports = async (
  req: Request,
  res: Response
) => {
  try {
    const { reportId, action } = req.body;

    if (action === 'resolve') {
      await prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'RESOLVED'
        }
      });
    }

    if (action === 'delete_target') {
      const report = await prisma.report.findUnique({
        where: { id: reportId }
      });

      if (!report) {
        return res.status(404).json({
          error: 'Report not found'
        });
      }

      await prisma.report.update({
        where: { id: reportId },
        data: {
          status: 'TARGET_DELETED'
        }
      });
    }

    res.json({
      status: 'handled'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to manage reports'
    });
  }
};

export const manageContent = async (
  req: Request,
  res: Response
) => {
  try {
    const { type, id } = req.body;

    if (type === 'reel') {
      await prisma.reel.delete({
        where: { id }
      });
    }

    if (type === 'story') {
      await prisma.story.delete({
        where: { id }
      });
    }

    if (type === 'comment') {
      await prisma.comment.delete({
        where: { id }
      });
    }

    if (type === 'room') {
      await prisma.voiceRoom.update({
        where: { id },
        data: {
          isActive: false
        }
      });
    }

    res.json({
      status: 'deleted'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to manage content'
    });
  }
};

export const setAnnouncement = async (
  req: Request,
  res: Response
) => {
  try {
    const ann =
      await prisma.announcement.create({
        data: {
          ...req.body,
          isActive: true
        }
      });

    io.emit('announcement:new', ann);

    res.json(ann);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to create announcement'
    });
  }
};

export const getAnalytics = async (
  req: Request,
  res: Response
) => {
  try {
    const [
      users,
      rooms,
      reels,
      reports
    ] = await Promise.all([
      prisma.user.count(),
      prisma.voiceRoom.count({
        where: {
          isActive: true
        }
      }),
      prisma.reel.count(),
      prisma.report.count({
        where: {
          status: 'PENDING'
        }
      })
    ]);

    res.json({
      users,
      activeRooms: rooms,
      reels,
      pendingReports: reports
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to fetch analytics'
    });
  }
};
