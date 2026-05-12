import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';

const MAX_CART_ITEMS = 100;
const MAX_ITEM_QUANTITY = 99;
const MIN_ITEM_QUANTITY = 1;

const toNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const safeJson = <T>(value: any, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeQuantity = (value: any) => {
  const quantity = Math.floor(toNumber(value, 1));
  return Math.min(MAX_ITEM_QUANTITY, Math.max(MIN_ITEM_QUANTITY, quantity));
};

const normalizeAttributes = (value: any) => {
  const attributes = safeJson<Record<string, any>>(value, {});
  return attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
};

const normalizeVariantId = (value: any) => {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length ? clean : null;
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
              status: true
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
    data: { userId },
    include: { items: true }
  });
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

  const enrichedItems = cart.items.map((item: any) => {
    const product = item.product;
    const unitPrice = Number(product?.price || 0);
    const compareAtPrice = product?.compareAtPrice ? Number(product.compareAtPrice) : null;
    const quantity = Number(item.quantity || 0);
    const lineTotal = unitPrice * quantity;
    const lineCompareTotal = compareAtPrice && compareAtPrice > unitPrice ? compareAtPrice * quantity : lineTotal;
    const availableInventory = Number(product?.inventory || 0);
    const isUnavailable = !product || product.status !== 'active' || product.visibility === 'private' || product.store?.status === 'disabled' || availableInventory < quantity;

    return {
      ...item,
      unitPrice,
      lineTotal,
      lineCompareTotal,
      savings: Math.max(0, lineCompareTotal - lineTotal),
      availableInventory,
      isUnavailable,
      stockWarning: availableInventory > 0 && availableInventory <= 5,
      maxAllowedQuantity: Math.min(MAX_ITEM_QUANTITY, Math.max(0, availableInventory))
    };
  });

  const availableItems = enrichedItems.filter((item: any) => !item.isUnavailable);
  const unavailableItems = enrichedItems.filter((item: any) => item.isUnavailable);
  const subtotal = availableItems.reduce((sum: number, item: any) => sum + item.lineTotal, 0);
  const compareSubtotal = availableItems.reduce((sum: number, item: any) => sum + item.lineCompareTotal, 0);
  const discountTotal = Math.max(0, compareSubtotal - subtotal);
  const taxTotal = 0;
  const shippingEstimate = 0;
  const total = subtotal + taxTotal + shippingEstimate;
  const itemCount = enrichedItems.length;
  const quantityTotal = enrichedItems.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0);

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
    ...unavailableItems.map((item: any) => ({
      type: 'unavailable',
      itemId: item.id,
      productId: item.productId,
      message: 'Product unavailable or stock changed'
    })),
    ...enrichedItems.filter((item: any) => item.stockWarning && !item.isUnavailable).map((item: any) => ({
      type: 'low_stock',
      itemId: item.id,
      productId: item.productId,
      message: 'Only a few units left'
    }))
  ];

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

const findMatchingCartItem = (items: any[], productId: string, variantId: string | null, attributes: Record<string, any>) => {
  const attrString = JSON.stringify(attributes || {});
  return items.find(item => {
    const itemVariantId = item.variantId || null;
    const itemAttrString = JSON.stringify(item.attributes || {});
    return item.productId === productId && itemVariantId === variantId && itemAttrString === attrString;
  });
};

const validateProductForCart = async (productId: string, quantity: number, variantId: string | null) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: {
        select: {
          id: true,
          status: true,
          ownerId: true
        }
      }
    }
  });

  if (!product || product.status !== 'active' || product.visibility === 'private' || product.store?.status === 'disabled') {
    return { error: 'Product unavailable' };
  }

  if (Number(product.inventory || 0) < quantity) {
    return { error: 'Product out of stock', available: Number(product.inventory || 0) };
  }

  if (variantId) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find((v: any) => v.id === variantId || v.sku === variantId);
    if (!variant) return { error: 'Variant unavailable' };
    if (variant.status && variant.status !== 'active') return { error: 'Variant unavailable' };
    if (Number(variant.inventory ?? product.inventory ?? 0) < quantity) {
      return { error: 'Variant out of stock', available: Number(variant.inventory ?? 0) };
    }
  }

  return { product };
};

export const addToCart = async (req: Request, res: Response) => {
  try {
    const { productId, quantity = 1, attributes, variantId } = req.body;
    const userId = req.userId!;

    if (!productId) return res.status(400).json({ error: 'Product required' });

    const qty = normalizeQuantity(quantity);
    const cleanAttributes = normalizeAttributes(attributes);
    const cleanVariantId = normalizeVariantId(variantId);

    const cart = await getOrCreateCart(userId);

    if (cart.items.length >= MAX_CART_ITEMS && !cart.items.some((item: any) => item.productId === productId)) {
      return res.status(400).json({ error: 'Cart item limit reached' });
    }

    const validation = await validateProductForCart(productId, qty, cleanVariantId);
    if (validation.error) return res.status(400).json(validation);

    const existingItem = findMatchingCartItem(cart.items, productId, cleanVariantId, cleanAttributes);

    if (existingItem) {
      const nextQuantity = Math.min(MAX_ITEM_QUANTITY, existingItem.quantity + qty);
      const stockCheck = await validateProductForCart(productId, nextQuantity, cleanVariantId);
      if (stockCheck.error) return res.status(400).json(stockCheck);

      await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: nextQuantity,
          attributes: cleanAttributes,
          variantId: cleanVariantId,
          updatedAt: new Date()
        }
      });
    } else {
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          quantity: qty,
          attributes: cleanAttributes,
          variantId: cleanVariantId
        }
      });
    }

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to add item to cart' });
  }
};

export const updateCartQuantity = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const { quantity } = req.body;
    const userId = req.userId!;

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true, product: true }
    });

    if (!item || item.cart.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    const qty = Math.floor(toNumber(quantity, 0));

    if (qty <= 0) {
      await prisma.cartItem.delete({ where: { id: itemId } });
      const updatedCart = await emitCart(userId);
      return res.json(updatedCart);
    }

    const cleanQuantity = Math.min(MAX_ITEM_QUANTITY, qty);
    const validation = await validateProductForCart(item.productId, cleanQuantity, item.variantId || null);
    if (validation.error) return res.status(400).json(validation);

    await prisma.cartItem.update({
      where: { id: itemId },
      data: {
        quantity: cleanQuantity,
        updatedAt: new Date()
      }
    });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to update cart quantity' });
  }
};

export const removeFromCart = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const userId = req.userId!;

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true }
    });

    if (!item || item.cart.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    await prisma.cartItem.delete({ where: { id: itemId } });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to remove item from cart' });
  }
};

export const getCart = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const cart = await getFullCart(userId);
    return res.json(cart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch cart' });
  }
};

export const clearCart = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const cart = await prisma.cart.findUnique({ where: { userId }, select: { id: true } });

    if (!cart) return res.json(await getFullCart(userId));

    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to clear cart' });
  }
};

export const removeUnavailableItems = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const cart = await getFullCart(userId);

    const ids = cart.unavailableItems.map((item: any) => item.id);

    if (ids.length) {
      await prisma.cartItem.deleteMany({
        where: { id: { in: ids } }
      });
    }

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to remove unavailable items' });
  }
};

export const syncCart = async (req: Request, res: Response) => {
  try {
    const { items = [] } = req.body;
    const userId = req.userId!;

    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be an array' });

    const cart = await getOrCreateCart(userId);
    const selectedItems = items.slice(0, MAX_CART_ITEMS);

    await prisma.$transaction(async tx => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      for (const item of selectedItems) {
        const productId = item.productId;
        if (!productId) continue;

        const qty = normalizeQuantity(item.quantity);
        const variantId = normalizeVariantId(item.variantId);
        const attributes = normalizeAttributes(item.attributes);
        const validation = await validateProductForCart(productId, qty, variantId);

        if (validation.error) continue;

        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId,
            quantity: qty,
            variantId,
            attributes
          }
        });
      }
    });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to sync cart' });
  }
};

export const moveCartItemToWishlist = async (req: Request, res: Response) => {
  try {
    const { itemId } = req.params;
    const userId = req.userId!;

    const item = await prisma.cartItem.findFirst({
      where: { id: itemId },
      include: { cart: true }
    });

    if (!item || item.cart.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    await prisma.$transaction(async tx => {
      await tx.wishlistItem.upsert({
        where: {
          userId_productId: {
            userId,
            productId: item.productId
          }
        },
        update: {
          updatedAt: new Date()
        },
        create: {
          userId,
          productId: item.productId,
          variantId: item.variantId || null,
          attributes: item.attributes || {}
        }
      });

      await tx.cartItem.delete({
        where: { id: itemId }
      });
    });

    const updatedCart = await emitCart(userId);
    io.to(`user:${userId}`).emit('wishlist:updated', { productId: item.productId });

    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to move item to wishlist' });
  }
};

export const applyCartCoupon = async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    const userId = req.userId!;

    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Coupon code required' });

    const cart = await getOrCreateCart(userId);
    const couponCode = code.trim().toUpperCase();

    const coupon = await prisma.coupon.findFirst({
      where: {
        code: couponCode,
        isActive: true,
        startsAt: { lte: new Date() },
        OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }]
      }
    }).catch(() => null);

    if (!coupon) return res.status(400).json({ error: 'Invalid or expired coupon' });

    await prisma.cart.update({
      where: { id: cart.id },
      data: {
        couponCode
      }
    });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to apply coupon' });
  }
};

export const removeCartCoupon = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const cart = await prisma.cart.findUnique({ where: { userId }, select: { id: true } });

    if (!cart) return res.json(await getFullCart(userId));

    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: null }
    });

    const updatedCart = await emitCart(userId);
    return res.json(updatedCart);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to remove coupon' });
  }
};
