import {
  Expo,
  ExpoPushMessage,
  ExpoPushTicket
} from 'expo-server-sdk';

import { prisma } from '../config/db';

const expo = new Expo({
  accessToken:
    process.env.EXPO_ACCESS_TOKEN
});

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  try {

    const tokenRecord =
      await prisma.pushToken.findUnique({
        where: {
          userId
        }
      });

    if (
      !tokenRecord ||
      !tokenRecord.isActive ||
      !Expo.isExpoPushToken(
        tokenRecord.token
      )
    ) {
      return;
    }

    const messages: ExpoPushMessage[] = [
      {
        to: tokenRecord.token,

        sound: 'default',

        title,
        body,

        data: data || {}
      }
    ];

    const tickets =
      await expo.sendPushNotificationsAsync(
        messages
      );

    await prisma.$transaction([
      prisma.notification.create({
        data: {
          userId,
          title,
          body,
          type: 'admin',
          data: data || {}
        }
      }),

      prisma.pushToken.update({
        where: {
          userId
        },

        data: {
          lastUsed: new Date()
        }
      })
    ]);

    return tickets;

  } catch (error) {

    console.error(
      'Push notification error:',
      error
    );

    return [];
  }
}

export async function broadcastNotification(
  title: string,
  body: string,
  type: string,
  data?: Record<string, any>
) {
  try {

    const tokens =
      await prisma.pushToken.findMany({
        where: {
          isActive: true
        }
      });

    const validTokens =
      tokens.filter((t) =>
        Expo.isExpoPushToken(
          t.token
        )
      );

    const messages: ExpoPushMessage[] =
      validTokens.map((t) => ({
        to: t.token,

        sound: 'default',

        title,
        body,

        data: data || {}
      }));

    const tickets: ExpoPushTicket[] =
      [];

    const chunks =
      expo.chunkPushNotifications(
        messages
      );

    for (const chunk of chunks) {

      const ticketChunk =
        await expo.sendPushNotificationsAsync(
          chunk
        );

      tickets.push(
        ...ticketChunk
      );
    }

    await prisma.notification.createMany({
      data: validTokens.map(
        (t) => ({
          userId: t.userId,

          title,
          body,

          type,

          data: data || {}
        })
      )
    });

    return tickets;

  } catch (error) {

    console.error(
      'Broadcast notification error:',
      error
    );

    return [];
  }
}

export async function checkPushReceipts(
  receiptIds: string[]
) {
  try {

    const receipts =
      await expo.getPushNotificationReceiptsAsync(
        receiptIds
      );

    for (const receipt of Object.values(
      receipts
    )) {

      if (
        receipt.status === 'error'
      ) {

        const token =
          (receipt as any)
            ?.details
            ?.expoPushToken;

        if (token) {

          await prisma.pushToken.updateMany({
            where: {
              token
            },

            data: {
              isActive: false
            }
          });
        }
      }
    }

  } catch (error) {

    console.error(
      'Receipt check error:',
      error
    );
  }
}
