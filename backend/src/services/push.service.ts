import {
  Expo,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket
} from 'expo-server-sdk';

import { prisma } from '../config/db';

type PushData = Record<string, any>;

type PushPriority = 'default' | 'normal' | 'high';

type PushNotificationType =
  | 'admin'
  | 'system'
  | 'message'
  | 'follow'
  | 'like'
  | 'comment'
  | 'order'
  | 'payment'
  | 'gift'
  | 'room'
  | 'reel'
  | 'story'
  | 'store'
  | 'wallet'
  | 'security';

type SendPushOptions = {
  type?: PushNotificationType | string;
  data?: PushData;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: PushPriority;
  ttl?: number;
  expiration?: number;
  subtitle?: string;
  categoryId?: string;
  mutableContent?: boolean;
  saveNotification?: boolean;
  silent?: boolean;
};

type BroadcastOptions = SendPushOptions & {
  userIds?: string[];
  excludeUserIds?: string[];
  limit?: number;
};

type PushTokenRecord = {
  id?: string;
  userId: string;
  token: string;
  isActive?: boolean | null;
};

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN
});

const DEFAULT_CHUNK_DELAY_MS = 120;
const DEFAULT_BROADCAST_LIMIT = 10000;
const MAX_BROADCAST_LIMIT = 50000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const toArray = <T = any>(value: any): T[] => Array.isArray(value) ? value : [];

const unique = <T>(items: T[]) => Array.from(new Set(items));

const safeNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeType = (type?: string): string => String(type || 'system').trim() || 'system';

const normalizeData = (data?: PushData): PushData => {
  if (!data || typeof data !== 'object') return {};
  return JSON.parse(JSON.stringify(data));
};

const buildMessage = (
  token: string,
  title: string,
  body: string,
  options: SendPushOptions = {}
): ExpoPushMessage => {
  const message: ExpoPushMessage = {
    to: token,
    title: options.silent ? undefined : title,
    body: options.silent ? undefined : body,
    data: normalizeData(options.data),
    sound: options.silent ? undefined : options.sound === null ? undefined : options.sound || 'default',
    priority: options.priority || 'high'
  };

  if (options.badge !== undefined) message.badge = options.badge;
  if (options.channelId) message.channelId = options.channelId;
  if (options.ttl !== undefined) message.ttl = options.ttl;
  if (options.expiration !== undefined) message.expiration = options.expiration;
  if (options.subtitle) message.subtitle = options.subtitle;
  if (options.categoryId) message.categoryId = options.categoryId;
  if (options.mutableContent !== undefined) message.mutableContent = options.mutableContent;

  return message;
};

async function createNotification(userId: string, title: string, body: string, type: string, data: PushData) {
  return prisma.notification.create({
    data: {
      userId,
      title,
      body,
      type,
      data
    } as any
  }).catch(() => null);
}

async function createManyNotifications(rows: Array<{ userId: string; title: string; body: string; type: string; data: PushData }>) {
  if (!rows.length) return { count: 0 };

  return prisma.notification.createMany({
    data: rows.map(row => ({
      userId: row.userId,
      title: row.title,
      body: row.body,
      type: row.type,
      data: row.data
    })) as any,
    skipDuplicates: true
  }).catch(async () => {
    await Promise.all(rows.map(row => createNotification(row.userId, row.title, row.body, row.type, row.data)));
    return { count: rows.length };
  });
}

async function getUserPushTokens(userId: string): Promise<PushTokenRecord[]> {
  const model = (prisma as any).pushToken;

  if (!model?.findMany) {
    const tokenRecord = await prisma.pushToken.findUnique({
      where: { userId }
    }).catch(() => null);

    return tokenRecord ? [tokenRecord] : [];
  }

  const many = await model.findMany({
    where: {
      userId,
      isActive: true
    }
  }).catch(() => []);

  if (many.length) return many;

  const single = await prisma.pushToken.findUnique({
    where: { userId }
  }).catch(() => null);

  return single ? [single] : [];
}

async function getBroadcastTokens(options: BroadcastOptions = {}): Promise<PushTokenRecord[]> {
  const userIds = unique(toArray<string>(options.userIds).filter(Boolean));
  const excludeUserIds = unique(toArray<string>(options.excludeUserIds).filter(Boolean));
  const limit = clamp(safeNumber(options.limit, DEFAULT_BROADCAST_LIMIT), 1, MAX_BROADCAST_LIMIT);

  return prisma.pushToken.findMany({
    where: {
      isActive: true,
      ...(userIds.length ? { userId: { in: userIds } } : {}),
      ...(excludeUserIds.length ? { userId: { notIn: excludeUserIds } } : {})
    } as any,
    take: limit
  }).catch(() => []);
}

function filterValidTokens(tokens: PushTokenRecord[]) {
  const seen = new Set<string>();
  return tokens.filter(token => {
    if (!token?.token) return false;
    if (token.isActive === false) return false;
    if (!Expo.isExpoPushToken(token.token)) return false;
    if (seen.has(token.token)) return false;
    seen.add(token.token);
    return true;
  });
}

async function markTokensInactive(tokens: string[]) {
  const valid = unique(tokens.filter(Boolean));
  if (!valid.length) return { count: 0 };

  return prisma.pushToken.updateMany({
    where: {
      token: { in: valid }
    } as any,
    data: {
      isActive: false
    } as any
  }).catch(() => ({ count: 0 }));
}

async function markTokensUsed(tokens: string[]) {
  const valid = unique(tokens.filter(Boolean));
  if (!valid.length) return { count: 0 };

  return prisma.pushToken.updateMany({
    where: {
      token: { in: valid }
    } as any,
    data: {
      lastUsed: new Date()
    } as any
  }).catch(() => ({ count: 0 }));
}

async function persistPushTickets(tickets: ExpoPushTicket[], tokenMap: Map<string, PushTokenRecord>, messages: ExpoPushMessage[]) {
  const model = (prisma as any).pushTicket;
  if (!model?.createMany || !tickets.length) return;

  const rows = tickets.map((ticket, index) => {
    const to = messages[index]?.to;
    const token = Array.isArray(to) ? to[0] : to;
    const record = token ? tokenMap.get(token) : null;

    return {
      userId: record?.userId || null,
      pushToken: token || null,
      ticketId: ticket.status === 'ok' ? ticket.id : null,
      status: ticket.status,
      message: ticket.status === 'error' ? ticket.message || null : null,
      details: ticket.status === 'error' ? (ticket as any).details || {} : {},
      raw: ticket as any
    };
  });

  await model.createMany({
    data: rows
  }).catch(() => undefined);
}

async function sendMessages(messages: ExpoPushMessage[], tokenMap: Map<string, PushTokenRecord>) {
  const tickets: ExpoPushTicket[] = [];
  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    const ticketChunk = await expo.sendPushNotificationsAsync(chunk).catch(error => {
      return chunk.map(() => ({
        status: 'error',
        message: error?.message || 'Expo push send failed',
        details: { error: error?.name || 'unknown' }
      })) as ExpoPushTicket[];
    });

    tickets.push(...ticketChunk);
    if (chunks.length > 1) await sleep(DEFAULT_CHUNK_DELAY_MS);
  }

  const invalidTokens: string[] = [];

  tickets.forEach((ticket, index) => {
    if (ticket.status !== 'error') return;
    const details = (ticket as any).details || {};
    const error = details.error || '';
    if (error === 'DeviceNotRegistered') {
      const to = messages[index]?.to;
      const token = Array.isArray(to) ? to[0] : to;
      if (token) invalidTokens.push(token);
    }
  });

  await Promise.all([
    invalidTokens.length ? markTokensInactive(invalidTokens) : Promise.resolve({ count: 0 }),
    persistPushTickets(tickets, tokenMap, messages)
  ]);

  return tickets;
}

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: PushData,
  options: SendPushOptions = {}
) {
  try {
    if (!userId || !title || !body) return [];

    const tokens = filterValidTokens(await getUserPushTokens(userId));
    const type = normalizeType(options.type || 'admin');
    const payload = normalizeData({ ...(data || {}), ...(options.data || {}) });

    if (options.saveNotification !== false) {
      await createNotification(userId, title, body, type, payload);
    }

    if (!tokens.length) return [];

    const tokenMap = new Map(tokens.map(token => [token.token, token]));
    const messages = tokens.map(token => buildMessage(token.token, title, body, { ...options, data: payload }));
    const tickets = await sendMessages(messages, tokenMap);

    await markTokensUsed(tokens.map(token => token.token));

    return tickets;
  } catch (error) {
    console.error('Push notification error:', error);
    return [];
  }
}

export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: PushData,
  options: SendPushOptions = {}
) {
  try {
    const ids = unique(toArray<string>(userIds).filter(Boolean));
    if (!ids.length || !title || !body) return [];

    const tokenRows = await prisma.pushToken.findMany({
      where: {
        userId: { in: ids },
        isActive: true
      } as any
    }).catch(() => []);

    const tokens = filterValidTokens(tokenRows);
    const type = normalizeType(options.type || 'system');
    const payload = normalizeData({ ...(data || {}), ...(options.data || {}) });

    if (options.saveNotification !== false) {
      await createManyNotifications(ids.map(userId => ({
        userId,
        title,
        body,
        type,
        data: payload
      })));
    }

    if (!tokens.length) return [];

    const tokenMap = new Map(tokens.map(token => [token.token, token]));
    const messages = tokens.map(token => buildMessage(token.token, title, body, { ...options, data: payload }));
    const tickets = await sendMessages(messages, tokenMap);

    await markTokensUsed(tokens.map(token => token.token));

    return tickets;
  } catch (error) {
    console.error('Multi-user push notification error:', error);
    return [];
  }
}

export async function broadcastNotification(
  title: string,
  body: string,
  type: string,
  data?: PushData,
  options: BroadcastOptions = {}
) {
  try {
    if (!title || !body) return [];

    const tokenRows = await getBroadcastTokens(options);
    const tokens = filterValidTokens(tokenRows);
    const normalizedType = normalizeType(type || options.type || 'system');
    const payload = normalizeData({ ...(data || {}), ...(options.data || {}) });
    const userIds = unique(tokens.map(token => token.userId).filter(Boolean));

    if (options.saveNotification !== false && userIds.length) {
      await createManyNotifications(userIds.map(userId => ({
        userId,
        title,
        body,
        type: normalizedType,
        data: payload
      })));
    }

    if (!tokens.length) return [];

    const tokenMap = new Map(tokens.map(token => [token.token, token]));
    const messages = tokens.map(token => buildMessage(token.token, title, body, { ...options, type: normalizedType, data: payload }));
    const tickets = await sendMessages(messages, tokenMap);

    await markTokensUsed(tokens.map(token => token.token));

    return tickets;
  } catch (error) {
    console.error('Broadcast notification error:', error);
    return [];
  }
}

export async function checkPushReceipts(receiptIds: string[]) {
  try {
    const ids = unique(toArray<string>(receiptIds).filter(Boolean));
    if (!ids.length) return {};

    const receipts = await expo.getPushNotificationReceiptsAsync(ids);
    const inactiveTokens: string[] = [];
    const model = (prisma as any).pushReceipt;

    for (const [receiptId, receipt] of Object.entries(receipts) as Array<[string, ExpoPushReceipt]>) {
      if (receipt.status === 'error') {
        const details = (receipt as any).details || {};
        const token = details.expoPushToken || details.pushToken || details.token;
        if (token && details.error === 'DeviceNotRegistered') inactiveTokens.push(token);
      }

      if (model?.upsert) {
        await model.upsert({
          where: { receiptId },
          update: {
            status: receipt.status,
            message: receipt.status === 'error' ? receipt.message || null : null,
            details: receipt.status === 'error' ? (receipt as any).details || {} : {},
            raw: receipt as any,
            checkedAt: new Date()
          },
          create: {
            receiptId,
            status: receipt.status,
            message: receipt.status === 'error' ? receipt.message || null : null,
            details: receipt.status === 'error' ? (receipt as any).details || {} : {},
            raw: receipt as any,
            checkedAt: new Date()
          }
        }).catch(() => undefined);
      }
    }

    if (inactiveTokens.length) await markTokensInactive(inactiveTokens);

    return receipts;
  } catch (error) {
    console.error('Receipt check error:', error);
    return {};
  }
}

export async function registerPushToken(userId: string, token: string, meta: PushData = {}) {
  if (!userId || !token || !Expo.isExpoPushToken(token)) {
    throw new Error('Invalid push token');
  }

  const existingByToken = await prisma.pushToken.findFirst({
    where: { token }
  }).catch(() => null);

  if (existingByToken) {
    return prisma.pushToken.update({
      where: { id: existingByToken.id } as any,
      data: {
        userId,
        isActive: true,
        lastUsed: new Date(),
        device: meta.device || (existingByToken as any).device || null,
        platform: meta.platform || (existingByToken as any).platform || null,
        metadata: meta
      } as any
    });
  }

  return prisma.pushToken.upsert({
    where: { userId } as any,
    update: {
      token,
      isActive: true,
      lastUsed: new Date(),
      device: meta.device || null,
      platform: meta.platform || null,
      metadata: meta
    } as any,
    create: {
      userId,
      token,
      isActive: true,
      lastUsed: new Date(),
      device: meta.device || null,
      platform: meta.platform || null,
      metadata: meta
    } as any
  });
}

export async function deactivatePushToken(token: string) {
  if (!token) return { count: 0 };

  return prisma.pushToken.updateMany({
    where: { token },
    data: { isActive: false } as any
  }).catch(() => ({ count: 0 }));
}

export async function deactivateUserPushTokens(userId: string) {
  if (!userId) return { count: 0 };

  return prisma.pushToken.updateMany({
    where: { userId },
    data: { isActive: false } as any
  }).catch(() => ({ count: 0 }));
}
