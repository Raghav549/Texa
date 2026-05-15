import { Server, Socket, Namespace } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';

type CommerceSocketData = {
  userId: string;
  role?: string | null;
};

type JwtPayload = {
  userId?: string;
  id?: string;
  role?: string;
  iat?: number;
  exp?: number;
};

type StoreSubscribePayload = {
  storeId?: string;
};

type InventoryAlertPayload = {
  productId?: string;
};

type OrderSubscribePayload = {
  orderId?: string;
};

type ProductSubscribePayload = {
  productId?: string;
};

type CartSyncPayload = {
  cartId?: string;
};

type RoomPrefix = 'product' | 'store' | 'order' | 'cart' | 'user' | 'store-owner';

const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 80;
const PRODUCT_ROOM_PREFIX: RoomPrefix = 'product';
const STORE_ROOM_PREFIX: RoomPrefix = 'store';
const ORDER_ROOM_PREFIX: RoomPrefix = 'order';
const CART_ROOM_PREFIX: RoomPrefix = 'cart';
const USER_ROOM_PREFIX: RoomPrefix = 'user';
const STORE_OWNER_ROOM_PREFIX: RoomPrefix = 'store-owner';

const socketBuckets = new Map<string, { count: number; resetAt: number }>();

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const header = socket.handshake.headers?.authorization;
  const queryToken = socket.handshake.query?.token;

  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return '';
}

function isValidId(value: any): value is string {
  return typeof value === 'string' && value.length >= 6 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function room(prefix: RoomPrefix, id: string) {
  return `${prefix}:${id}`;
}

function normalizeNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rateLimit(socket: Socket) {
  const key = socket.id;
  const now = Date.now();
  const bucket = socketBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    socketBuckets.set(key, { count: 1, resetAt: now + SOCKET_RATE_LIMIT_WINDOW });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= SOCKET_RATE_LIMIT_MAX;
}

function emitError(socket: Socket, code: string, message: string, extra: Record<string, any> = {}) {
  socket.emit('commerce:error', {
    code,
    message,
    ...extra,
    at: new Date().toISOString()
  });
}

function getJWTSecret() {
  const secret = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw new Error('JWT secret missing');
  return secret;
}

async function getUserRole(userId: string, fallback?: string | null) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isBanned: true } as any
  });

  if (!user || (user as any).isBanned) return null;

  return String((user as any).role || fallback || '').toLowerCase();
}

function isAdminRole(role?: string | null) {
  const normalized = String(role || '').toLowerCase();
  return ['admin', 'super_admin', 'superadmin', 'owner'].includes(normalized);
}

async function canAccessStore(userId: string, storeId: string, role?: string | null) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      ownerId: true,
      userId: true,
      status: true,
      isVerified: true
    } as any
  });

  if (!store || (store as any).status === 'disabled') return { allowed: false, store: null };
  if (isAdminRole(role)) return { allowed: true, store };

  const ownerId = (store as any).ownerId || (store as any).userId;
  return { allowed: ownerId === userId, store };
}

async function canViewStore(storeId: string) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      status: true
    } as any
  });

  return !!store && (store as any).status !== 'disabled';
}

async function canAccessOrder(userId: string, orderId: string, role?: string | null) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerId: true,
      userId: true,
      storeId: true,
      store: {
        select: {
          ownerId: true,
          userId: true
        } as any
      }
    } as any
  });

  if (!order) return { allowed: false, order: null };
  if (isAdminRole(role)) return { allowed: true, order };

  const buyerId = (order as any).buyerId || (order as any).userId;
  const ownerId = (order as any).store?.ownerId || (order as any).store?.userId;

  return { allowed: buyerId === userId || ownerId === userId, order };
}

async function canAccessProductRoom(userId: string, productId: string, role?: string | null) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      storeId: true,
      status: true,
      store: {
        select: {
          ownerId: true,
          userId: true,
          status: true
        } as any
      }
    } as any
  });

  if (!product || (product as any).store?.status === 'disabled') return { allowed: false, product: null };
  if (isAdminRole(role)) return { allowed: true, product };
  if ((product as any).status === 'active') return { allowed: true, product };

  const ownerId = (product as any).store?.ownerId || (product as any).store?.userId;
  return { allowed: ownerId === userId, product };
}

async function getCartPayload(userId: string) {
  const cart = await prisma.cart.findUnique({
    where: { userId } as any,
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              price: true,
              compareAtPrice: true,
              inventory: true,
              primaryMediaUrl: true,
              imageUrl: true,
              status: true,
              storeId: true,
              store: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  logoUrl: true,
                  isVerified: true
                } as any
              }
            } as any
          }
        },
        orderBy: { createdAt: 'desc' }
      }
    } as any
  }).catch(() => null);

  if (!cart) {
    return {
      id: null,
      userId,
      items: [],
      total: 0,
      subtotal: 0,
      itemCount: 0,
      updatedAt: new Date()
    };
  }

  const items = Array.isArray((cart as any).items) ? (cart as any).items : [];
  const validItems = items.filter((item: any) => item.product && item.product.status === 'active');
  const subtotal = validItems.reduce((sum: number, item: any) => sum + normalizeNumber(item.product.price) * normalizeNumber(item.quantity, 1), 0);
  const itemCount = validItems.reduce((sum: number, item: any) => sum + normalizeNumber(item.quantity, 1), 0);

  return {
    ...(cart as any),
    items: validItems,
    subtotal,
    total: subtotal,
    itemCount
  };
}

async function emitCartSync(ns: Namespace, userId: string) {
  const payload = await getCartPayload(userId);
  ns.to(room(CART_ROOM_PREFIX, userId)).emit('cart:synced', payload);
  ns.to(room(USER_ROOM_PREFIX, userId)).emit('cart:synced', payload);
  return payload;
}

async function emitInventorySnapshot(socket: Socket, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      storeId: true,
      inventory: true,
      lowStockThreshold: true,
      status: true,
      updatedAt: true
    } as any
  });

  if (!product) {
    emitError(socket, 'PRODUCT_NOT_FOUND', 'Product not found');
    return;
  }

  const inventory = normalizeNumber((product as any).inventory);
  const lowStockThreshold = normalizeNumber((product as any).lowStockThreshold);

  socket.emit('inventory:snapshot', {
    productId: (product as any).id,
    storeId: (product as any).storeId,
    inventory,
    lowStockThreshold,
    isLowStock: inventory <= lowStockThreshold,
    status: (product as any).status,
    updatedAt: (product as any).updatedAt
  });
}

function bindRateLimit(socket: Socket) {
  socket.use((packet, next) => {
    if (!rateLimit(socket)) {
      emitError(socket, 'RATE_LIMITED', 'Too many socket events');
      return;
    }
    next();
  });
}

export function initCommerceSockets(io: Server) {
  const ns = io.of('/commerce');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);
      if (!token) return next(new Error('Auth required'));

      const decoded = jwt.verify(token, getJWTSecret()) as JwtPayload;
      const userId = decoded?.userId || decoded?.id;

      if (!userId || !isValidId(userId)) return next(new Error('Invalid token'));

      const role = await getUserRole(userId, decoded.role);
      if (role === null) return next(new Error('User blocked or not found'));

      (socket.data as CommerceSocketData).userId = userId;
      (socket.data as CommerceSocketData).role = role;

      return next();
    } catch {
      return next(new Error('Auth required'));
    }
  });

  ns.on('connection', async (socket: Socket) => {
    const userId = (socket.data as CommerceSocketData).userId;
    const role = (socket.data as CommerceSocketData).role || null;

    bindRateLimit(socket);

    socket.join(room(USER_ROOM_PREFIX, userId));
    socket.join(room(CART_ROOM_PREFIX, userId));

    socket.emit('commerce:connected', {
      userId,
      role,
      socketId: socket.id,
      connectedAt: new Date().toISOString()
    });

    await emitCartSync(ns, userId).catch(() => null);

    socket.on('cart:sync', async (_payload: CartSyncPayload = {}) => {
      await emitCartSync(ns, userId).catch(() => emitError(socket, 'CART_SYNC_FAILED', 'Unable to sync cart'));
    });

    socket.on('store:subscribe', async ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');

      const allowed = await canViewStore(storeId);
      if (!allowed) return emitError(socket, 'STORE_NOT_FOUND', 'Store not found');

      socket.join(room(STORE_ROOM_PREFIX, storeId));
      socket.emit('store:subscribed', { storeId });
    });

    socket.on('store:owner_subscribe', async ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');

      const access = await canAccessStore(userId, storeId, role);
      if (!access.allowed) return emitError(socket, 'STORE_ACCESS_DENIED', 'Store access denied');

      socket.join(room(STORE_ROOM_PREFIX, storeId));
      socket.join(room(STORE_OWNER_ROOM_PREFIX, storeId));
      socket.emit('store:owner_subscribed', { storeId });
    });

    socket.on('store:unsubscribe', ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');

      socket.leave(room(STORE_ROOM_PREFIX, storeId));
      socket.leave(room(STORE_OWNER_ROOM_PREFIX, storeId));
      socket.emit('store:unsubscribed', { storeId });
    });

    socket.on('product:subscribe', async ({ productId }: ProductSubscribePayload = {}) => {
      if (!isValidId(productId)) return emitError(socket, 'INVALID_PRODUCT_ID', 'Invalid product id');

      const access = await canAccessProductRoom(userId, productId, role);
      if (!access.allowed || !access.product) return emitError(socket, 'PRODUCT_ACCESS_DENIED', 'Product access denied');

      socket.join(room(PRODUCT_ROOM_PREFIX, productId));
      socket.emit('product:subscribed', { productId });
      await emitInventorySnapshot(socket, productId);
    });

    socket.on('product:unsubscribe', ({ productId }: ProductSubscribePayload = {}) => {
      if (!isValidId(productId)) return emitError(socket, 'INVALID_PRODUCT_ID', 'Invalid product id');

      socket.leave(room(PRODUCT_ROOM_PREFIX, productId));
      socket.emit('product:unsubscribed', { productId });
    });

    socket.on('inventory:alert', async ({ productId }: InventoryAlertPayload = {}) => {
      if (!isValidId(productId)) return emitError(socket, 'INVALID_PRODUCT_ID', 'Invalid product id');

      const access = await canAccessProductRoom(userId, productId, role);
      if (!access.allowed || !access.product) return emitError(socket, 'PRODUCT_ACCESS_DENIED', 'Product access denied');

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          storeId: true,
          inventory: true,
          lowStockThreshold: true,
          status: true,
          updatedAt: true
        } as any
      });

      if (!product) return emitError(socket, 'PRODUCT_NOT_FOUND', 'Product not found');

      const inventory = normalizeNumber((product as any).inventory);
      const lowStockThreshold = normalizeNumber((product as any).lowStockThreshold);
      const isLowStock = inventory <= lowStockThreshold;

      const payload = {
        productId: (product as any).id,
        storeId: (product as any).storeId,
        inventory,
        lowStockThreshold,
        isLowStock,
        status: (product as any).status,
        updatedAt: (product as any).updatedAt
      };

      ns.to(room(PRODUCT_ROOM_PREFIX, (product as any).id)).emit('inventory:update', payload);
      ns.to(room(STORE_ROOM_PREFIX, (product as any).storeId)).emit('inventory:update', payload);

      if (isLowStock) {
        const lowPayload = {
          ...payload,
          severity: inventory <= 0 ? 'out_of_stock' : 'low_stock'
        };

        ns.to(room(STORE_ROOM_PREFIX, (product as any).storeId)).emit('inventory:low', lowPayload);
        ns.to(room(STORE_OWNER_ROOM_PREFIX, (product as any).storeId)).emit('inventory:low_priority', lowPayload);
      }

      socket.emit('inventory:alert_checked', {
        productId: (product as any).id,
        isLowStock,
        inventory
      });
    });

    socket.on('order:subscribe', async ({ orderId }: OrderSubscribePayload = {}) => {
      if (!isValidId(orderId)) return emitError(socket, 'INVALID_ORDER_ID', 'Invalid order id');

      const access = await canAccessOrder(userId, orderId, role);
      if (!access.allowed || !access.order) return emitError(socket, 'ORDER_ACCESS_DENIED', 'Order access denied');

      socket.join(room(ORDER_ROOM_PREFIX, orderId));
      socket.emit('order:subscribed', { orderId });
    });

    socket.on('order:unsubscribe', ({ orderId }: OrderSubscribePayload = {}) => {
      if (!isValidId(orderId)) return emitError(socket, 'INVALID_ORDER_ID', 'Invalid order id');

      socket.leave(room(ORDER_ROOM_PREFIX, orderId));
      socket.emit('order:unsubscribed', { orderId });
    });

    socket.on('order:status_request', async ({ orderId }: OrderSubscribePayload = {}) => {
      if (!isValidId(orderId)) return emitError(socket, 'INVALID_ORDER_ID', 'Invalid order id');

      const access = await canAccessOrder(userId, orderId, role);
      if (!access.allowed || !access.order) return emitError(socket, 'ORDER_ACCESS_DENIED', 'Order access denied');

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          trackingNumber: true,
          carrier: true,
          updatedAt: true,
          total: true,
          storeId: true,
          buyerId: true
        } as any
      });

      socket.emit('order:status_snapshot', order);
    });

    socket.on('commerce:presence', async () => {
      socket.emit('commerce:presence_ack', {
        userId,
        role,
        online: true,
        rooms: Array.from(socket.rooms),
        at: new Date().toISOString()
      });
    });

    socket.on('disconnect', () => {
      socketBuckets.delete(socket.id);
    });
  });

  return ns;
}

export async function emitCartUpdated(io: Server, userId: string, cart?: any) {
  const ns = io.of('/commerce');
  const payload = cart || await getCartPayload(userId).catch(() => null);

  if (!payload) return;

  ns.to(room(CART_ROOM_PREFIX, userId)).emit('cart:updated', payload);
  ns.to(room(USER_ROOM_PREFIX, userId)).emit('cart:updated', payload);
}

export function emitProductUpdated(io: Server, product: any) {
  if (!product?.id) return;

  const ns = io.of('/commerce');

  ns.to(room(PRODUCT_ROOM_PREFIX, product.id)).emit('product:updated', product);

  if (product.storeId) {
    ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('product:updated', product);
    ns.to(room(STORE_OWNER_ROOM_PREFIX, product.storeId)).emit('product:updated', product);
  }
}

export function emitInventoryUpdated(io: Server, product: any) {
  if (!product?.id) return;

  const ns = io.of('/commerce');
  const inventory = normalizeNumber(product.inventory);
  const lowStockThreshold = normalizeNumber(product.lowStockThreshold);
  const isLowStock = inventory <= lowStockThreshold;

  const payload = {
    productId: product.id,
    storeId: product.storeId,
    inventory,
    lowStockThreshold,
    isLowStock,
    status: product.status,
    updatedAt: product.updatedAt || new Date()
  };

  ns.to(room(PRODUCT_ROOM_PREFIX, product.id)).emit('inventory:update', payload);

  if (product.storeId) {
    ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('inventory:update', payload);
    ns.to(room(STORE_OWNER_ROOM_PREFIX, product.storeId)).emit('inventory:update', payload);
  }

  if (isLowStock && product.storeId) {
    const lowPayload = {
      ...payload,
      severity: inventory <= 0 ? 'out_of_stock' : 'low_stock'
    };

    ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('inventory:low', lowPayload);
    ns.to(room(STORE_OWNER_ROOM_PREFIX, product.storeId)).emit('inventory:low_priority', lowPayload);
  }
}

export function emitOrderUpdated(io: Server, order: any) {
  if (!order?.id) return;

  const ns = io.of('/commerce');

  const payload = {
    orderId: order.id,
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    trackingNumber: order.trackingNumber,
    carrier: order.carrier,
    total: order.total,
    storeId: order.storeId,
    buyerId: order.buyerId || order.userId,
    updatedAt: order.updatedAt || new Date()
  };

  ns.to(room(ORDER_ROOM_PREFIX, order.id)).emit('order:updated', payload);

  if (payload.buyerId) {
    ns.to(room(USER_ROOM_PREFIX, payload.buyerId)).emit('order:updated', payload);
  }

  if (order.storeId) {
    ns.to(room(STORE_ROOM_PREFIX, order.storeId)).emit('order:updated', payload);
    ns.to(room(STORE_OWNER_ROOM_PREFIX, order.storeId)).emit('order:updated', payload);
  }
}

export function emitStoreUpdated(io: Server, store: any) {
  if (!store?.id) return;

  const ns = io.of('/commerce');

  ns.to(room(STORE_ROOM_PREFIX, store.id)).emit('store:updated', store);
  ns.to(room(STORE_OWNER_ROOM_PREFIX, store.id)).emit('store:updated', store);
}

export function emitCommerceNotification(io: Server, userId: string, payload: any) {
  if (!userId) return;

  io.of('/commerce').to(room(USER_ROOM_PREFIX, userId)).emit('commerce:notification', {
    ...payload,
    at: new Date().toISOString()
  });
}

export function getCommerceRoom(prefix: RoomPrefix, id: string) {
  return room(prefix, id);
}
