import { Request, Response } from 'express';
import { ProductStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { io } from '../app';

const MAX_CART_ITEMS = 100;
const MAX_ITEM_QUANTITY = 99;
const MIN_ITEM_QUANTITY = 1;

const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const safeJson = <T>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value as T;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeQuantity = (value: unknown) => {
  const quantity = Math.floor(toNumber(value, 1));
  return Math.min(MAX_ITEM_QUANTITY, Math.max(MIN_ITEM_QUANTITY, quantity));
};

const normalizeAttributes = (value: unknown) => {
  const attributes = safeJson<Record<string, unknown>>(value, {});
  return attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
};

const getAuthUserId = (req: Request) => {
  const request = req as Request & {
    userId?: string;
    user?: { id?: string; userId?: string };
    auth?: { userId?: string; id?: string };
  };

  return request.userId || request.user?.id || request.user?.userId || request.auth?.userId || request.auth?.id || '';
};

const sendError = (res: Response, status: number, error: string, code = 'CART_ERROR', extra: Record<string, unknown> = {}) => {
  return res.status(status).json({
    success: false,
    ok: false,
    error,
    code,
    ...extra
  });
};

const sendSuccess = (res: Response, data: unknown, status = 200) => {
  return res.status(status).json({
    success: true,
    ok: true,
    cart: data
  });
};

const cartInclude = {
  items: {
    include: {
      product: {
        include: {
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              isVerified: true,
              trustScore: true,
              rating: true,
              ratingCount: true,
              ownerId: true
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' as const }
  }
};

const getOrCreateCart = async (userId: string) => {
  const existing = await prisma.cart.findUnique({
    where: { userId },
    include: { items: true }
  });

  if (existing) return existing;

  return prisma.cart.create({
    data: {
      userId,
      total: 0
    },
    include: { items: true }
  });
};

const calculateCartTotal = (items: Array<{ product?: { price?: number | null; status?: ProductStatus | null; inventory?: number | null } | null; quantity?: number | null }>) => {
  return items.reduce((sum, item) => {
    const product = item.product;
    const quantity = Number(item.quantity || 0);
    const price = Number(product?.price || 0);
    const inventory = Number(product?.inventory || 0);

    if (!product || product.status !== ProductStatus.ACTIVE || inventory < quantity) return sum;

    return sum + price * quantity;
  }, 0);
};

const refreshCartTotal = async (cartId: string) => {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        include: {
          product: true
        }
      }
    }
  });

  if (!cart) return 0;

  const total = calculateCartTotal(cart.items);

  await prisma.cart.update({
    where: { id: cartId },
    data: { total }
  });

  return total;
};

const getFullCart = async (userId: string) => {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: cartInclude
  });

  if (!cart) {
    return {
      id: null,
      userId,
      items: [],
      subtotal: 0,
      compareSubtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      shippingEstimate: 0,
      total: 0,
      itemCount: 0,
      quantityTotal: 0,
      stores: [],
      unavailableItems: [],
      warnings: []
    };
  }

  const enrichedItems = cart.items.map(item => {
    const product = item.product;
    const unitPrice = Number(product?.price || 0);
    const compareAtPrice = product?.compareAtPrice ? Number(product.compareAtPrice) : null;
    const quantity = Number(item.quantity || 0);
    const lineTotal = unitPrice * quantity;
    const lineCompareTotal = compareAtPrice && compareAtPrice > unitPrice ? compareAtPrice * quantity : lineTotal;
    const availableInventory = Number(product?.inventory || 0);
    const isUnavailable = !product || product.status !== ProductStatus.ACTIVE || availableInventory < quantity;

    return {
      ...item,
      unitPrice,
      lineTotal,
      lineCompareTotal,
      savings: Math.max(0, lineCompareTotal - lineTotal),
      availableInventory,
      isUnavailable,
      stockWarning: availableInventory > 0 && availableInventory <= Number(product?.lowStockThreshold || 5),
      maxAllowedQuantity: Math.min(MAX_ITEM_QUANTITY, Math.max(0, availableInventory))
    };
  });

  const availableItems = enrichedItems.filter(item => !item.isUnavailable);
  const unavailableItems = enrichedItems.filter(item => item.isUnavailable);
  const subtotal = availableItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const compareSubtotal = availableItems.reduce((sum, item) => sum + item.lineCompareTotal, 0);
  const discountTotal = Math.max(0, compareSubtotal - subtotal);
  const taxTotal = 0;
  const shippingEstimate = 0;
  const total = subtotal + taxTotal + shippingEstimate;
  const itemCount = enrichedItems.length;
  const quantityTotal = enrichedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const storesMap = new Map<string, any>();

  for (const item of enrichedItems) {
    const store = item.product?.store;
    if (!store) continue;

    const current = storesMap.get(store.id) || {
      id: store.id,
      name: store.name,
      slug: store.slug,
      logoUrl: store.logoUrl,
      isVerified: store.isVerified,
      trustScore: store.trustScore,
      rating: store.rating,
      ratingCount: store.ratingCount,
      ownerId: store.ownerId,
      itemCount: 0,
      quantityTotal: 0,
      subtotal: 0
    };

    current.itemCount += 1;
    current.quantityTotal += Number(item.quantity || 0);
    if (!item.isUnavailable) current.subtotal += item.lineTotal;
    storesMap.set(store.id, current);
  }

  const warnings = [
    ...unavailableItems.map(item => ({
      type: 'unavailable',
      itemId: item.id,
      productId: item.productId,
      message: 'Product unavailable or stock changed'
    })),
    ...enrichedItems
      .filter(item => item.stockWarning && !item.isUnavailable)
      .map(item => ({
        type: 'low_stock',
        itemId: item.id,
        productId: item.productId,
        message: 'Only a few units left'
      }))
  ];

  if (Number(cart.total || 0) !== total) {
    await prisma.cart.update({
      where: { id: cart.id },
      data: { total }
    });
  }

  return {
    ...cart,
    items: enrichedItems,
    subtotal,
    compareSubtotal,
    discountTotal,
    taxTotal,
    shippingEstimate,
    total,
    itemCount,
    quantityTotal,
    stores: Array.from(storesMap.values()),
    unavailableItems,
    warnings
  };
};

const emitCart = async (userId: string) => {
  const cart = await getFullCart(userId);
  io.to(`cart:${userId}`).emit('cart:updated', cart);
  io.to(`user:${userId}`).emit('cart:updated', cart);
  return cart;
};

const findMatchingCartItem = (items: Array<{ productId: string; attributes?: unknown }>, productId: string, attributes: Record<string, unknown>) => {
  const attrString = JSON.stringify(attributes || {});

  return items.find(item => {
    const itemAttrString = JSON.stringify(item.attributes || {});
    return item.productId === productId && itemAttrString === attrString;
  });
};

const validateProductForCart = async (productId: string, quantity: number) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: {
        select: {
          id: true,
          ownerId: true,
          isVerified: true
        }
      }
    }
  });

  if (!product || product.status !== ProductStatus.ACTIVE) {
    return {
      error: 'Product unavailable',
      code: 'PRODUCT_UNAVAILABLE'
    };
  }

  if (Number(product.inventory || 0) < quantity) {
    return {
      error: 'Product out of stock',
      code: 'OUT_OF_STOCK',
      available: Number(product.inventory || 0)
    };
  }

  return { product };
};

export const addToCart = async (req: Request, res: Response) => {
  try {
    const { productId, quantity = 1, attributes } = req.body;
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    if (!productId || typeof productId !== 'string') return sendError(res, 400, 'Product required', 'PRODUCT_REQUIRED');

    const qty = normalizeQuantity(quantity);
    const cleanAttributes = normalizeAttributes(attributes);
    const cart = await getOrCreateCart(userId);

    if (cart.items.length >= MAX_CART_ITEMS && !cart.items.some(item => item.productId === productId)) {
      return sendError(res, 400, 'Cart item limit reached', 'CART_LIMIT_REACHED');
    }

    const validation = await validateProductForCart(productId, qty);

    if (validation.error) {
      return sendError(res, 400, validation.error, validation.code, {
        available: validation.available
      });
    }

    const existingItem = findMatchingCartItem(cart.items, productId, cleanAttributes);

    await prisma.$transaction(async tx => {
      if (existingItem) {
        const nextQuantity = Math.min(MAX_ITEM_QUANTITY, existingItem.quantity + qty);
        const stockCheck = await validateProductForCart(productId, nextQuantity);

        if (stockCheck.error) {
          throw Object.assign(new Error(stockCheck.error), {
            statusCode: 400,
            code: stockCheck.code,
            available: stockCheck.available
          });
        }

        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: {
            quantity: nextQuantity,
            attributes: cleanAttributes
          }
        });
      } else {
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId,
            quantity: qty,
            attributes: cleanAttributes
          }
        });
      }
    });

    await refreshCartTotal(cart.id);

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, Number(error?.statusCode || 500), error?.message || 'Failed to add item to cart', error?.code || 'ADD_TO_CART_FAILED', {
      available: error?.available
    });
  }
};

export const updateCartQuantity = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const { quantity } = req.body;
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    if (!itemId) return sendError(res, 400, 'Cart item required', 'ITEM_REQUIRED');

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true, product: true }
    });

    if (!item || item.cart.userId !== userId) return sendError(res, 403, 'Access denied', 'ACCESS_DENIED');

    const qty = Math.floor(toNumber(quantity, 0));

    if (qty <= 0) {
      await prisma.cartItem.delete({ where: { id: itemId } });
      await refreshCartTotal(item.cartId);
      const updatedCart = await emitCart(userId);
      return sendSuccess(res, updatedCart);
    }

    const cleanQuantity = Math.min(MAX_ITEM_QUANTITY, qty);
    const validation = await validateProductForCart(item.productId, cleanQuantity);

    if (validation.error) {
      return sendError(res, 400, validation.error, validation.code, {
        available: validation.available
      });
    }

    await prisma.cartItem.update({
      where: { id: itemId },
      data: {
        quantity: cleanQuantity
      }
    });

    await refreshCartTotal(item.cartId);

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to update cart quantity', 'UPDATE_CART_FAILED');
  }
};

export const removeFromCart = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    if (!itemId) return sendError(res, 400, 'Cart item required', 'ITEM_REQUIRED');

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true }
    });

    if (!item || item.cart.userId !== userId) return sendError(res, 403, 'Access denied', 'ACCESS_DENIED');

    await prisma.cartItem.delete({ where: { id: itemId } });
    await refreshCartTotal(item.cartId);

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to remove item from cart', 'REMOVE_CART_FAILED');
  }
};

export const getCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');

    const cart = await getFullCart(userId);
    return sendSuccess(res, cart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to fetch cart', 'FETCH_CART_FAILED');
  }
};

export const clearCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');

    const cart = await prisma.cart.findUnique({
      where: { userId },
      select: { id: true }
    });

    if (!cart) {
      const emptyCart = await getFullCart(userId);
      return sendSuccess(res, emptyCart);
    }

    await prisma.$transaction(async tx => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({
        where: { id: cart.id },
        data: { total: 0 }
      });
    });

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to clear cart', 'CLEAR_CART_FAILED');
  }
};

export const removeUnavailableItems = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');

    const cart = await getFullCart(userId);
    const ids = cart.unavailableItems.map((item: any) => item.id);

    if (ids.length) {
      await prisma.cartItem.deleteMany({
        where: { id: { in: ids } }
      });

      if (cart.id) await refreshCartTotal(cart.id);
    }

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to remove unavailable items', 'REMOVE_UNAVAILABLE_FAILED');
  }
};

export const syncCart = async (req: Request, res: Response) => {
  try {
    const { items = [] } = req.body;
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    if (!Array.isArray(items)) return sendError(res, 400, 'Items must be an array', 'INVALID_ITEMS');

    const cart = await getOrCreateCart(userId);
    const selectedItems = items.slice(0, MAX_CART_ITEMS);
    const mergedItems = new Map<string, { productId: string; quantity: number; attributes: Record<string, unknown> }>();

    for (const item of selectedItems) {
      const productId = typeof item?.productId === 'string' ? item.productId.trim() : '';
      if (!productId) continue;

      const quantity = normalizeQuantity(item.quantity);
      const attributes = normalizeAttributes(item.attributes);
      const key = `${productId}:${JSON.stringify(attributes)}`;
      const existing = mergedItems.get(key);

      if (existing) {
        existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + quantity);
      } else {
        mergedItems.set(key, {
          productId,
          quantity,
          attributes
        });
      }
    }

    await prisma.$transaction(async tx => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      for (const item of mergedItems.values()) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: {
            id: true,
            status: true,
            inventory: true
          }
        });

        if (!product || product.status !== ProductStatus.ACTIVE || Number(product.inventory || 0) < item.quantity) continue;

        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId: item.productId,
            quantity: item.quantity,
            attributes: item.attributes
          }
        });
      }
    });

    await refreshCartTotal(cart.id);

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to sync cart', 'SYNC_CART_FAILED');
  }
};

export const getCartSummary = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');

    const cart = await getFullCart(userId);

    return res.status(200).json({
      success: true,
      ok: true,
      summary: {
        id: cart.id,
        itemCount: cart.itemCount,
        quantityTotal: cart.quantityTotal,
        subtotal: cart.subtotal,
        compareSubtotal: cart.compareSubtotal,
        discountTotal: cart.discountTotal,
        taxTotal: cart.taxTotal,
        shippingEstimate: cart.shippingEstimate,
        total: cart.total,
        stores: cart.stores,
        warnings: cart.warnings
      }
    });
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to fetch cart summary', 'FETCH_CART_SUMMARY_FAILED');
  }
};

export const setCartItemAttributes = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const { attributes } = req.body;
    const userId = getAuthUserId(req);

    if (!userId) return sendError(res, 401, 'Authentication required', 'AUTH_REQUIRED');
    if (!itemId) return sendError(res, 400, 'Cart item required', 'ITEM_REQUIRED');

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true }
    });

    if (!item || item.cart.userId !== userId) return sendError(res, 403, 'Access denied', 'ACCESS_DENIED');

    const cleanAttributes = normalizeAttributes(attributes);

    const duplicate = await prisma.cartItem.findFirst({
      where: {
        cartId: item.cartId,
        productId: item.productId,
        id: { not: item.id }
      }
    });

    if (duplicate && JSON.stringify(duplicate.attributes || {}) === JSON.stringify(cleanAttributes)) {
      const nextQuantity = Math.min(MAX_ITEM_QUANTITY, duplicate.quantity + item.quantity);
      const validation = await validateProductForCart(item.productId, nextQuantity);

      if (validation.error) {
        return sendError(res, 400, validation.error, validation.code, {
          available: validation.available
        });
      }

      await prisma.$transaction(async tx => {
        await tx.cartItem.update({
          where: { id: duplicate.id },
          data: { quantity: nextQuantity }
        });

        await tx.cartItem.delete({
          where: { id: item.id }
        });
      });
    } else {
      await prisma.cartItem.update({
        where: { id: itemId },
        data: { attributes: cleanAttributes }
      });
    }

    await refreshCartTotal(item.cartId);

    const updatedCart = await emitCart(userId);
    return sendSuccess(res, updatedCart);
  } catch (error: any) {
    return sendError(res, 500, error?.message || 'Failed to update item attributes', 'UPDATE_ATTRIBUTES_FAILED');
  }
};
