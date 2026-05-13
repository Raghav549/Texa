import { Request, Response } from 'express';
import { NotificationType, UserRole } from '@prisma/client';
import { prisma } from '../config/prisma';
import { broadcastNotification, sendPushToUser } from '../services/push.service';
import { io } from '../app';

const allowedNotificationTypes = new Set(Object.values(NotificationType));

const normalizeNotificationType = (type: unknown): NotificationType => {
  if (typeof type !== 'string') return NotificationType.SYSTEM;
  const clean = type.trim().toUpperCase();
  return allowedNotificationTypes.has(clean as NotificationType) ? (clean as NotificationType) : NotificationType.SYSTEM;
};

const safeLimit = (value: unknown, fallback = 50, max = 100) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const safeData = (value: unknown) => {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

const requireAdmin = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isBanned: true }
  });

  if (!user || user.isBanned) return false;
  return user.role === UserRole.ADMIN || user.role === UserRole.SUPERADMIN;
};

const createNotificationForUser = async (
  userId: string,
  title: string,
  body: string | null,
  type: NotificationType,
  data: Record<string, unknown>
) => {
  return prisma.notification.create({
    data: {
      userId,
      title,
      body,
      type,
      data
    }
  });
};

const emitNotificationToUser = async (userId: string, notification: unknown) => {
  io.to(`user:${userId}`).emit('notification:new', notification);
};

export const registerPushToken = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { token, platform, deviceType, deviceName, deviceId } = req.body;

    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Push token is required'
      });
    }

    const cleanToken = token.trim();
    const cleanPlatform = typeof platform === 'string' && platform.trim() ? platform.trim().toLowerCase() : 'unknown';
    const cleanDeviceType = typeof deviceType === 'string' && deviceType.trim() ? deviceType.trim() : cleanPlatform;
    const cleanDeviceName = typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim() : null;
    const cleanDeviceId = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null;

    let session = null;

    if (cleanDeviceId) {
      session = await prisma.deviceSession.findFirst({
        where: {
          userId,
          deviceId: cleanDeviceId
        },
        select: { id: true }
      });
    }

    if (!session) {
      session = await prisma.deviceSession.findFirst({
        where: {
          userId,
          pushToken: cleanToken
        },
        select: { id: true }
      });
    }

    const deviceSession = session
      ? await prisma.deviceSession.update({
          where: { id: session.id },
          data: {
            deviceType: cleanDeviceType,
            deviceName: cleanDeviceName,
            deviceId: cleanDeviceId,
            pushToken: cleanToken,
            isActive: true,
            lastActive: new Date()
          }
        })
      : await prisma.deviceSession.create({
          data: {
            userId,
            deviceType: cleanDeviceType,
            deviceName: cleanDeviceName,
            deviceId: cleanDeviceId,
            pushToken: cleanToken,
            isActive: true,
            lastActive: new Date()
          }
        });

    return res.json({
      success: true,
      status: 'registered',
      session: {
        id: deviceSession.id,
        deviceType: deviceSession.deviceType,
        deviceName: deviceSession.deviceName,
        deviceId: deviceSession.deviceId,
        isActive: deviceSession.isActive,
        lastActive: deviceSession.lastActive
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to register push token'
    });
  }
};

export const unregisterPushToken = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { token, deviceId } = req.body;

    if (!token && !deviceId) {
      return res.status(400).json({
        success: false,
        error: 'Token or deviceId is required'
      });
    }

    await prisma.deviceSession.updateMany({
      where: {
        userId,
        OR: [
          ...(typeof token === 'string' && token.trim() ? [{ pushToken: token.trim() }] : []),
          ...(typeof deviceId === 'string' && deviceId.trim() ? [{ deviceId: deviceId.trim() }] : [])
        ]
      },
      data: {
        pushToken: null,
        isActive: false,
        lastActive: new Date()
      }
    });

    return res.json({
      success: true,
      status: 'unregistered'
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to unregister push token'
    });
  }
};

export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = safeLimit(req.query.limit, 50, 100);
    const unreadOnly = req.query.unreadOnly === 'true';
    const type = req.query.type ? normalizeNotificationType(req.query.type) : null;
    const before = req.query.before ? new Date(String(req.query.before)) : null;

    const where: any = {
      userId,
      ...(unreadOnly ? { isRead: false } : {}),
      ...(type ? { type } : {})
    };

    if (before && !Number.isNaN(before.getTime())) {
      where.createdAt = { lt: before };
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: {
        createdAt: 'desc'
      },
      take: limit + 1
    });

    const hasMore = notifications.length > limit;
    const page = hasMore ? notifications.slice(0, limit) : notifications;

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    });

    return res.json({
      success: true,
      notifications: page,
      unreadCount,
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.createdAt : null
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch notifications'
    });
  }
};

export const getUnreadNotificationCount = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    });

    return res.json({
      success: true,
      unreadCount
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch unread notification count'
    });
  }
};

export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const notificationId = req.params.id || req.body.notificationId;

    if (!notificationId) {
      return res.status(400).json({
        success: false,
        error: 'Notification id is required'
      });
    }

    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId
      }
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: {
        isRead: true,
        readAt: notification.readAt || new Date()
      }
    });

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    });

    io.to(`user:${userId}`).emit('notification:read', {
      notificationId: updated.id,
      unreadCount
    });

    return res.json({
      success: true,
      notification: updated,
      unreadCount
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to mark notification as read'
    });
  }
};

export const markAllRead = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    await prisma.notification.updateMany({
      where: {
        userId,
        isRead: false
      },
      data: {
        isRead: true,
        readAt: new Date()
      }
    });

    io.to(`user:${userId}`).emit('notification:all_read', {
      unreadCount: 0
    });

    return res.json({
      success: true,
      status: 'read',
      unreadCount: 0
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to mark notifications as read'
    });
  }
};

export const deleteNotification = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const notificationId = req.params.id || req.body.notificationId;

    if (!notificationId) {
      return res.status(400).json({
        success: false,
        error: 'Notification id is required'
      });
    }

    await prisma.notification.deleteMany({
      where: {
        id: notificationId,
        userId
      }
    });

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        isRead: false
      }
    });

    io.to(`user:${userId}`).emit('notification:deleted', {
      notificationId,
      unreadCount
    });

    return res.json({
      success: true,
      status: 'deleted',
      unreadCount
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to delete notification'
    });
  }
};

export const clearNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    await prisma.notification.deleteMany({
      where: {
        userId
      }
    });

    io.to(`user:${userId}`).emit('notification:cleared', {
      unreadCount: 0
    });

    return res.json({
      success: true,
      status: 'cleared',
      unreadCount: 0
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to clear notifications'
    });
  }
};

export const adminSendNotification = async (req: Request, res: Response) => {
  try {
    const adminId = req.userId!;
    const isAdmin = await requireAdmin(adminId);

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { title, body, type, targetUserId, data } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Notification title is required'
      });
    }

    const cleanTitle = title.trim();
    const cleanBody = typeof body === 'string' ? body.trim() : null;
    const cleanType = normalizeNotificationType(type);
    const cleanData = safeData(data);

    if (targetUserId) {
      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, isBanned: true }
      });

      if (!targetUser || targetUser.isBanned) {
        return res.status(404).json({
          success: false,
          error: 'Target user not found'
        });
      }

      const notification = await createNotificationForUser(targetUserId, cleanTitle, cleanBody, cleanType, cleanData);

      await sendPushToUser(targetUserId, cleanTitle, cleanBody || '', {
        ...cleanData,
        notificationId: notification.id,
        type: cleanType
      }).catch(() => null);

      await emitNotificationToUser(targetUserId, notification);

      return res.json({
        success: true,
        status: 'sent',
        mode: 'targeted',
        notification
      });
    }

    const users = await prisma.user.findMany({
      where: {
        isBanned: false
      },
      select: {
        id: true
      },
      take: 5000
    });

    const notifications = await prisma.notification.createMany({
      data: users.map((user) => ({
        userId: user.id,
        title: cleanTitle,
        body: cleanBody,
        type: cleanType,
        data: cleanData
      })),
      skipDuplicates: true
    });

    await broadcastNotification(cleanTitle, cleanBody || '', cleanType, cleanData).catch(() => null);

    io.emit('notification:broadcast', {
      title: cleanTitle,
      body: cleanBody,
      type: cleanType,
      data: cleanData,
      createdAt: new Date()
    });

    return res.json({
      success: true,
      status: 'sent',
      mode: 'broadcast',
      count: notifications.count
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to send notification'
    });
  }
};

export const createSystemNotification = async (
  userId: string,
  title: string,
  body?: string | null,
  type: NotificationType = NotificationType.SYSTEM,
  data: Record<string, unknown> = {}
) => {
  const notification = await createNotificationForUser(userId, title, body || null, type, data);

  await sendPushToUser(userId, title, body || '', {
    ...data,
    notificationId: notification.id,
    type
  }).catch(() => null);

  await emitNotificationToUser(userId, notification);

  return notification;
};
