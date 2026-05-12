import { Server, Socket } from 'socket.io';
import { prisma } from '../config/db';
import jwt from 'jsonwebtoken';

type CommerceSocketData = {
  userId: string;
  role?: string;
};

type JwtPayload = {
  userId: string;
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

const SOCKET_RATE_LIMIT_WINDOW = 10_000;
const SOCKET_RATE_LIMIT_MAX = 80;
const PRODUCT_ROOM_PREFIX = 'product';
const STORE_ROOM_PREFIX = 'store';
const ORDER_ROOM_PREFIX = 'order';
const CART_ROOM_PREFIX = 'cart';
const USER_ROOM_PREFIX = 'user';

const socketBuckets = new Map<string, { count: number; resetAt: number }>();

function getToken(socket: Socket) {
  const authToken = socket.handshake.auth?.token;
  const header = socket.handshake.headers?.authorization;
  if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

function isValidId(value: any) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value);
}

function room(prefix: string, id: string) {
  return `${prefix}:${id}`;
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
  if (bucket.count > SOCKET_RATE_LIMIT_MAX) return false;
  return true;
}

function emitError(socket: Socket, code: string, message: string) {
  socket.emit('commerce:error', { code, message });
}

async function canAccessStore(userId: string, storeId: string) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, ownerId: true, status: true }
  });
  if (!store || store.status === 'disabled') return { allowed: false, store: null };
  return { allowed: store.ownerId === userId, store };
}

async function canAccessOrder(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, buyerId: true, storeId: true, store: { select: { ownerId: true } } }
  });
  if (!order) return { allowed: false, order: null };
  return { allowed: order.buyerId === userId || order.store?.ownerId === userId, order };
}

async function canAccessProductRoom(userId: string, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, storeId: true, status: true, store: { select: { ownerId: true, status: true } } }
  });
  if (!product || product.store?.status === 'disabled') return { allowed: false, product: null };
  if (product.status === 'active') return { allowed: true, product };
  return { allowed: product.store?.ownerId === userId, product };
}

async function getCartPayload(userId: string) {
  const cart = await prisma.cart.findUnique({
    where: { userId },
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
              status: true,
              storeId: true,
              store: { select: { id: true, name: true, slug: true, logoUrl: true, isVerified: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  if (!cart) return { items: [], total: 0, itemCount: 0 };

  const validItems = cart.items.filter(item => item.product && item.product.status === 'active');
  const total = validItems.reduce((sum, item) => sum + Number(item.product.price || 0) * item.quantity, 0);
  const itemCount = validItems.reduce((sum, item) => sum + item.quantity, 0);

  return { ...cart, items: validItems, total, itemCount };
}

async function emitCartSync(ns: ReturnType<Server['of']>, userId: string) {
  const payload = await getCartPayload(userId);
  ns.to(room(CART_ROOM_PREFIX, userId)).emit('cart:synced', payload);
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
    }
  });

  if (!product) {
    emitError(socket, 'PRODUCT_NOT_FOUND', 'Product not found');
    return;
  }

  socket.emit('inventory:snapshot', {
    productId: product.id,
    storeId: product.storeId,
    inventory: product.inventory,
    lowStockThreshold: product.lowStockThreshold,
    isLowStock: Number(product.inventory) <= Number(product.lowStockThreshold || 0),
    status: product.status,
    updatedAt: product.updatedAt
  });
}

export function initCommerceSockets(io: Server) {
  const ns = io.of('/commerce');

  ns.use(async (socket: Socket, next) => {
    try {
      const token = getToken(socket);
      if (!token) return next(new Error('Auth required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET || '') as JwtPayload;
      if (!decoded?.userId) return next(new Error('Invalid token'));
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      return next();
    } catch {
      return next(new Error('Auth required'));
    }
  });

  ns.on('connection', async (socket: Socket) => {
    const userId = socket.data.userId as string;

    socket.join(room(USER_ROOM_PREFIX, userId));
    socket.join(room(CART_ROOM_PREFIX, userId));

    socket.emit('commerce:connected', {
      userId,
      socketId: socket.id,
      connectedAt: new Date().toISOString()
    });

    await emitCartSync(ns, userId).catch(() => null);

    socket.use((packet, next) => {
      if (!rateLimit(socket)) {
        emitError(socket, 'RATE_LIMITED', 'Too many socket events');
        return;
      }
      next();
    });

    socket.on('cart:sync', async (_payload: CartSyncPayload = {}) => {
      await emitCartSync(ns, userId).catch(() => emitError(socket, 'CART_SYNC_FAILED', 'Unable to sync cart'));
    });

    socket.on('store:subscribe', async ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true, status: true }
      });
      if (!store || store.status === 'disabled') return emitError(socket, 'STORE_NOT_FOUND', 'Store not found');
      socket.join(room(STORE_ROOM_PREFIX, storeId));
      socket.emit('store:subscribed', { storeId });
    });

    socket.on('store:owner_subscribe', async ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');
      const access = await canAccessStore(userId, storeId);
      if (!access.allowed) return emitError(socket, 'STORE_ACCESS_DENIED', 'Store access denied');
      socket.join(room(STORE_ROOM_PREFIX, storeId));
      socket.join(`store-owner:${storeId}`);
      socket.emit('store:owner_subscribed', { storeId });
    });

    socket.on('store:unsubscribe', ({ storeId }: StoreSubscribePayload = {}) => {
      if (!isValidId(storeId)) return emitError(socket, 'INVALID_STORE_ID', 'Invalid store id');
      socket.leave(room(STORE_ROOM_PREFIX, storeId));
      socket.leave(`store-owner:${storeId}`);
      socket.emit('store:unsubscribed', { storeId });
    });

    socket.on('product:subscribe', async ({ productId }: ProductSubscribePayload = {}) => {
      if (!isValidId(productId)) return emitError(socket, 'INVALID_PRODUCT_ID', 'Invalid product id');
      const access = await canAccessProductRoom(userId, productId);
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

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          storeId: true,
          inventory: true,
          lowStockThreshold: true,
          status: true,
          store: { select: { ownerId: true } }
        }
      });

      if (!product) return emitError(socket, 'PRODUCT_NOT_FOUND', 'Product not found');

      const isLowStock = Number(product.inventory) <= Number(product.lowStockThreshold || 0);

      ns.to(room(PRODUCT_ROOM_PREFIX, product.id)).emit('inventory:update', {
        productId: product.id,
        storeId: product.storeId,
        inventory: product.inventory,
        lowStockThreshold: product.lowStockThreshold,
        isLowStock
      });

      if (isLowStock) {
        ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('inventory:low', {
          productId: product.id,
          storeId: product.storeId,
          inventory: product.inventory,
          lowStockThreshold: product.lowStockThreshold
        });
        ns.to(`store-owner:${product.storeId}`).emit('inventory:low_priority', {
          productId: product.id,
          storeId: product.storeId,
          inventory: product.inventory,
          lowStockThreshold: product.lowStockThreshold,
          severity: Number(product.inventory) <= 0 ? 'out_of_stock' : 'low_stock'
        });
      }

      socket.emit('inventory:alert_checked', {
        productId: product.id,
        isLowStock,
        inventory: product.inventory
      });
    });

    socket.on('order:subscribe', async ({ orderId }: OrderSubscribePayload = {}) => {
      if (!isValidId(orderId)) return emitError(socket, 'INVALID_ORDER_ID', 'Invalid order id');
      const access = await canAccessOrder(userId, orderId);
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
      const access = await canAccessOrder(userId, orderId);
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
          total: true
        }
      });

      socket.emit('order:status_snapshot', order);
    });

    socket.on('commerce:presence', async () => {
      socket.emit('commerce:presence_ack', {
        userId,
        online: true,
        rooms: Array.from(socket.rooms),
        at: new Date().toISOString()
      });
    });

    socket.on('disconnect', () => {
      socketBuckets.delete(socket.id);
      socket.leave(room(USER_ROOM_PREFIX, userId));
      socket.leave(room(CART_ROOM_PREFIX, userId));
    });
  });

  return ns;
}

export function emitCartUpdated(io: Server, userId: string, cart: any) {
  io.of('/commerce').to(room(CART_ROOM_PREFIX, userId)).emit('cart:updated', cart);
}

export function emitProductUpdated(io: Server, product: any) {
  const ns = io.of('/commerce');
  ns.to(room(PRODUCT_ROOM_PREFIX, product.id)).emit('product:updated', product);
  if (product.storeId) ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('product:updated', product);
}

export function emitInventoryUpdated(io: Server, product: any) {
  const ns = io.of('/commerce');
  const isLowStock = Number(product.inventory) <= Number(product.lowStockThreshold || 0);

  const payload = {
    productId: product.id,
    storeId: product.storeId,
    inventory: product.inventory,
    lowStockThreshold: product.lowStockThreshold,
    isLowStock
  };

  ns.to(room(PRODUCT_ROOM_PREFIX, product.id)).emit('inventory:update', payload);
  ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('inventory:update', payload);

  if (isLowStock) {
    ns.to(room(STORE_ROOM_PREFIX, product.storeId)).emit('inventory:low', {
      ...payload,
      severity: Number(product.inventory) <= 0 ? 'out_of_stock' : 'low_stock'
    });
  }
}

export function emitOrderUpdated(io: Server, order: any) {
  const ns = io.of('/commerce');

  const payload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    trackingNumber: order.trackingNumber,
    carrier: order.carrier,
    total: order.total,
    updatedAt: order.updatedAt || new Date()
  };

  ns.to(room(ORDER_ROOM_PREFIX, order.id)).emit('order:updated', payload);
  if (order.buyerId) ns.to(room(USER_ROOM_PREFIX, order.buyerId)).emit('order:updated', payload);
  if (order.storeId) ns.to(room(STORE_ROOM_PREFIX, order.storeId)).emit('order:updated', payload);
}
