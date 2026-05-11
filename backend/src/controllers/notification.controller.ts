import { Request, Response } from 'express';

import { prisma } from '../config/db';

import {
  broadcastNotification,
  sendPushToUser
} from '../services/push.service';

import { io } from '../app';

export const registerPushToken = async (
  req: Request,
  res: Response
) => {
  try {
    const { token, platform } =
      req.body;

    await prisma.pushToken.upsert({
      where: {
        userId: req.userId!
      },

      update: {
        token,
        platform,
        isActive: true
      },

      create: {
        userId: req.userId!,
        token,
        platform,
        isActive: true
      }
    });

    res.json({
      status: 'registered'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to register push token'
    });
  }
};

export const getNotifications = async (
  req: Request,
  res: Response
) => {
  try {
    const notifs =
      await prisma.notification.findMany({
        where: {
          userId: req.userId!
        },

        orderBy: {
          createdAt: 'desc'
        },

        take: 50
      });

    res.json(notifs);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to fetch notifications'
    });
  }
};

export const markAllRead = async (
  req: Request,
  res: Response
) => {
  try {
    await prisma.notification.updateMany({
      where: {
        userId: req.userId!,
        isRead: false
      },

      data: {
        isRead: true
      }
    });

    res.json({
      status: 'read'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to mark notifications as read'
    });
  }
};

export const adminSendNotification = async (
  req: Request,
  res: Response
) => {
  try {
    const {
      title,
      body,
      type,
      targetUserId,
      data
    } = req.body;

    if (targetUserId) {

      await sendPushToUser(
        targetUserId,
        title,
        body,
        data
      );

      io.to(`user:${targetUserId}`).emit(
        'notification:new',
        {
          title,
          body,
          type,
          data
        }
      );

    } else {

      await broadcastNotification(
        title,
        body,
        type || 'broadcast',
        data
      );

      io.emit(
        'notification:broadcast',
        {
          title,
          body,
          type,
          data
        }
      );
    }

    res.json({
      status: 'sent'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        'Failed to send notification'
    });
  }
};
