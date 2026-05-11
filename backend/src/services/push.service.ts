import { Expo, ExpoPushMessage, ExpoPushTicket, ExpoPushReceipt } from 'expo-server-sdk';
import { prisma } from '../config/db';
const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

export async function sendPushToUser(userId: string, title: string, body: string, data?: Record<string, any>) {
  const tokenRecord = await prisma.pushToken.findUnique({ where: { userId } });
  if (!tokenRecord || !tokenRecord.isActive || !Expo.isExpoPushToken(tokenRecord.token)) return;
  
  const messages: ExpoPushMessage[] = [{ to: tokenRecord.token, sound: 'default', title, body, data: data || {} }];
  const tickets = await expo.sendPushNotificationsAsync(messages);
  
  await prisma.$transaction([
    prisma.notification.create({ data: { userId, title, body, type: 'admin', data: data || {} } }),
    prisma.pushToken.update({ where: { userId }, data: { lastUsed: new Date() } })
  ]);
  return tickets;
}

export async function broadcastNotification(title: string, body: string, type: string, data?: Record<string, any>) {
  const tokens = await prisma.pushToken.findMany({ where: { isActive: true } });
  const messages: ExpoPushMessage[] = tokens.map(t => ({ to: t.token, sound: 'default', title, body, data: data || {} }));
  
  const tickets: ExpoPushTicket[] = [];
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
    tickets.push(...ticketChunk);
  }

  await prisma.notification.createMany({
    data: tokens.map(t => ({ userId: t.userId, title, body, type, data: data || {} }))
  });
  return tickets;
}

export async function checkPushReceipts(receiptIds: string[]) {
  const receipts = await expo.getPushNotificationReceiptsAsync(receiptIds);
  for (const [id, receipt] of Object.entries(receipts)) {
    if (receipt.status === 'error') {
      await prisma.pushToken.updateMany({ where: { token: (receipt as any).details?.expoPushToken }, data: { isActive: false } });
    }
  }
}
