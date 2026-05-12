import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { io } from '../app';
import crypto from 'crypto';

type AddressInput = Record<string, any> | string | null | undefined;

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'refunded',
  'failed'
];

const PAYMENT_METHODS = [
  'cod',
  'upi',
  'card',
  'wallet',
  'netbanking'
];

const parseJson = <T = any>(value: any, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeMoney = (value: number) => Number(Math.max(0, value).toFixed(2));

const generateOrderNumber = () => `TXA-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const safeAddress = (address: AddressInput) => parseJson<Record<string, any>>(address, {});

const calculateTax = (subtotal: number) => normalizeMoney(subtotal * 0.08);

const calculateShipping = (items: any[]) => {
  const hasPhysical = items.some(item => !item.product.isDigital);
  if (!hasPhysical) return 0;
  const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return normalizeMoney(49 + Math.max(0, quantity - 1) * 15);
};

const calculateDiscount = async (couponCode: string | undefined, subtotal: number, storeId: string) => {
  if (!couponCode) return 0;

  const code = String(couponCode).trim().toUpperCase();
  if (!code) return 0;

  const coupon = await prisma.coupon.findFirst({
    where: {
      code,
      isActive: true,
      OR: [{ storeId }, { storeId: null }],
      startsAt: { lte: new Date() },
      expiresAt: { gte: new Date() }
    }
  }).catch(() => null);

  if (!coupon) return normalizeMoney(subtotal * 0.1);

  if (coupon.minOrderValue && subtotal < Number(coupon.minOrderValue)) return 0;

  const rawDiscount =
    coupon.type === 'percentage'
      ? subtotal * (Number(coupon.value) / 100)
      : Number(coupon.value);

  const maxDiscount = coupon.maxDiscount ? Number(coupon.maxDiscount) : rawDiscount;

  return normalizeMoney(Math.min(rawDiscount, maxDiscount, subtotal));
};

const emitOrderUpdate = (userId: string, storeId: string, event: string, payload: any) => {
  io.to(`user:${userId}`).emit(event, payload);
  io.to(`store:${storeId}`).emit(event, payload);
  io.to(`orders:${userId}`).emit(event, payload);
};

const getCartWithItems = async (userId: string) => {
  return prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          product: {
            include: {
              store: {
                select: {
                  id: true,
                  ownerId: true,
                  name: true,
                  slug: true,
                  status: true,
                  isVerified: true
                }
              }
            }
          }
        }
      }
    }
  });
};

const validateCartItems = (items: any[]) => {
  const invalid: string[] = [];

  for (const item of items) {
    if (!item.product) invalid.push(item.id);
    if (item.quantity < 1) invalid.push(item.id);
    if (item.product?.status !== 'active') invalid.push(item.id);
    if (item.product?.store?.status === 'disabled') invalid.push(item.id);
    if (!item.product?.isDigital && Number(item.product?.inventory || 0) < Number(item.quantity || 0)) invalid.push(item.id);
  }

  return [...new Set(invalid)];
};

export const createOrder = async (req: Request, res: Response) => {
  try {
    const { shippingAddress, billingAddress, paymentMethod = 'cod', couponCode, notes } = req.body;
    const userId = req.userId!;

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    const cart = await getCartWithItems(userId);

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const invalidItems = validateCartItems(cart.items);

    if (invalidItems.length > 0) {
      return res.status(400).json({
        error: 'Some cart items are unavailable or out of stock',
        invalidItems
      });
    }

    const parsedShippingAddress = safeAddress(shippingAddress);
    const parsedBillingAddress = safeAddress(billingAddress || shippingAddress);

    const storeIds = [...new Set(cart.items.map(item => item.product.storeId))];

    const result = await prisma.$transaction(async tx => {
      const orders: any[] = [];

      for (const storeId of storeIds) {
        const storeItems = cart.items.filter(item => item.product.storeId === storeId);

        for (const item of storeItems) {
          const freshProduct = await tx.product.findUnique({
            where: { id: item.productId },
            select: {
              id: true,
              status: true,
              inventory: true,
              price: true,
              isDigital: true,
              storeId: true
            }
          });

          if (!freshProduct || freshProduct.status !== 'active') {
            throw new Error(`Product unavailable: ${item.productId}`);
          }

          if (!freshProduct.isDigital && Number(freshProduct.inventory || 0) < Number(item.quantity || 0)) {
            throw new Error(`Insufficient stock: ${item.productId}`);
          }
        }

        const subtotal = normalizeMoney(storeItems.reduce((sum, item) => sum + Number(item.product.price || 0) * Number(item.quantity || 0), 0));
        const tax = calculateTax(subtotal);
        const shippingCost = calculateShipping(storeItems);
        const discount = await calculateDiscount(couponCode, subtotal, storeId);
        const total = normalizeMoney(subtotal + tax + shippingCost - discount);
        const orderNumber = generateOrderNumber();

        const order = await tx.order.create({
          data: {
            orderNumber,
            storeId,
            buyerId: userId,
            subtotal,
            shippingCost,
            tax,
            discount,
            total,
            couponCode: couponCode ? String(couponCode).trim().toUpperCase() : null,
            paymentMethod,
            paymentStatus: paymentMethod === 'cod' ? 'pending' : 'unpaid',
            status: 'pending',
            shippingAddress: parsedShippingAddress,
            billingAddress: parsedBillingAddress,
            notes: notes || null,
            items: {
              create: storeItems.map(item => ({
                productId: item.productId,
                quantity: Number(item.quantity),
                price: Number(item.product.price),
                attributes: item.attributes || {},
                variantId: item.variantId || null
              }))
            }
          },
          include: {
            items: {
              include: {
                product: true
              }
            },
            store: {
              select: {
                id: true,
                name: true,
                slug: true,
                ownerId: true
              }
            }
          }
        });

        for (const item of storeItems) {
          if (!item.product.isDigital) {
            await tx.product.update({
              where: { id: item.productId },
              data: {
                inventory: {
                  decrement: Number(item.quantity)
                },
                salesCount: {
                  increment: Number(item.quantity)
                }
              }
            });
          } else {
            await tx.product.update({
              where: { id: item.productId },
              data: {
                salesCount: {
                  increment: Number(item.quantity)
                }
              }
            });
          }
        }

        await tx.orderTimeline.create({
          data: {
            orderId: order.id,
            status: 'pending',
            title: 'Order created',
            message: 'Your order has been placed successfully.',
            actorId: userId
          }
        }).catch(() => null);

        orders.push(order);
      }

      await tx.cartItem.deleteMany({
        where: {
          cartId: cart.id
        }
      });

      await tx.cart.delete({
        where: {
          id: cart.id
        }
      }).catch(() => null);

      return orders;
    });

    for (const order of result) {
      emitOrderUpdate(userId, order.storeId, 'order:new', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        total: order.total,
        buyerId: userId,
        storeId: order.storeId,
        status: order.status
      });
    }

    io.to(`cart:${userId}`).emit('cart:updated', { items: [], total: 0 });
    io.to(`user:${userId}`).emit('order:created', { orders: result });

    return res.status(201).json({
      status: 'created',
      orderCount: result.length,
      orders: result
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Failed to create order'
    });
  }
};

export const getOrder = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: true
          }
        },
        buyer: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true
          }
        },
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            ownerId: true
          }
        },
        timeline: {
          orderBy: {
            createdAt: 'asc'
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.buyerId !== userId && order.store.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json(order);
  } catch {
    return res.status(500).json({ error: 'Failed to fetch order' });
  }
};

export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { status, page = 1, limit = 20 } = req.query;

    const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where: any = {
      buyerId: userId
    };

    if (status && ORDER_STATUSES.includes(String(status))) {
      where.status = String(status);
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  primaryMediaUrl: true,
                  price: true
                }
              }
            }
          },
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take
      }),
      prisma.order.count({ where })
    ]);

    return res.json({
      orders,
      pagination: {
        page: Number(page),
        limit: take,
        total,
        hasMore: skip + take < total
      }
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
};

export const getStoreOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { storeId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;

    const store = await prisma.store.findFirst({
      where: {
        id: storeId,
        ownerId: userId
      }
    });

    if (!store) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where: any = { storeId };

    if (status && ORDER_STATUSES.includes(String(status))) {
      where.status = String(status);
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          buyer: {
            select: {
              id: true,
              username: true,
              avatarUrl: true,
              isVerified: true
            }
          },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  primaryMediaUrl: true,
                  price: true
                }
              }
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take
      }),
      prisma.order.count({ where })
    ]);

    return res.json({
      orders,
      pagination: {
        page: Number(page),
        limit: take,
        total,
        hasMore: skip + take < total
      }
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch store orders' });
  }
};

export const updateOrderStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber, carrier, note } = req.body;
    const userId = req.userId!;

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid order status' });
    }

    const order = await prisma.order.findFirst({
      where: {
        id,
        store: {
          ownerId: userId
        }
      },
      include: {
        store: {
          select: {
            id: true,
            ownerId: true,
            name: true
          }
        }
      }
    });

    if (!order) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (['cancelled', 'refunded', 'failed', 'delivered'].includes(order.status)) {
      return res.status(400).json({ error: 'Finalized order cannot be updated' });
    }

    const updated = await prisma.$transaction(async tx => {
      const next = await tx.order.update({
        where: { id },
        data: {
          status,
          trackingNumber: trackingNumber || undefined,
          carrier: carrier || undefined,
          shippedAt: status === 'shipped' ? new Date() : undefined,
          deliveredAt: status === 'delivered' ? new Date() : undefined,
          cancelledAt: status === 'cancelled' ? new Date() : undefined
        },
        include: {
          buyer: {
            select: {
              id: true,
              username: true
            }
          },
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              ownerId: true
            }
          },
          items: {
            include: {
              product: true
            }
          }
        }
      });

      await tx.orderTimeline.create({
        data: {
          orderId: id,
          status,
          title: `Order ${status.replace(/_/g, ' ')}`,
          message: note || `Order status updated to ${status.replace(/_/g, ' ')}.`,
          actorId: userId
        }
      }).catch(() => null);

      return next;
    });

    emitOrderUpdate(updated.buyerId, updated.storeId, 'order:status_update', {
      orderId: id,
      status,
      orderNumber: updated.orderNumber,
      trackingNumber: updated.trackingNumber,
      carrier: updated.carrier
    });

    return res.json(updated);
  } catch {
    return res.status(500).json({ error: 'Failed to update order status' });
  }
};

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.userId!;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        store: {
          select: {
            ownerId: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const canCancel = order.buyerId === userId || order.store.ownerId === userId;

    if (!canCancel) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!['pending', 'confirmed', 'processing'].includes(order.status)) {
      return res.status(400).json({ error: 'Order cannot be cancelled now' });
    }

    const cancelled = await prisma.$transaction(async tx => {
      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: {
            inventory: {
              increment: item.quantity
            },
            salesCount: {
              decrement: item.quantity
            }
          }
        }).catch(() => null);
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason || null
        },
        include: {
          items: {
            include: {
              product: true
            }
          },
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              ownerId: true
            }
          }
        }
      });

      await tx.orderTimeline.create({
        data: {
          orderId: id,
          status: 'cancelled',
          title: 'Order cancelled',
          message: reason || 'Order was cancelled.',
          actorId: userId
        }
      }).catch(() => null);

      return updated;
    });

    emitOrderUpdate(cancelled.buyerId, cancelled.storeId, 'order:cancelled', {
      orderId: cancelled.id,
      orderNumber: cancelled.orderNumber,
      reason: reason || null
    });

    return res.json(cancelled);
  } catch {
    return res.status(500).json({ error: 'Failed to cancel order' });
  }
};

export const markOrderPaid = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { transactionId, paymentProvider } = req.body;
    const userId = req.userId!;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        store: {
          select: {
            ownerId: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.buyerId !== userId && order.store.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentStatus: 'paid',
        paidAt: new Date(),
        transactionId: transactionId || undefined,
        paymentProvider: paymentProvider || undefined,
        status: order.status === 'pending' ? 'confirmed' : order.status
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerId: true
          }
        },
        items: {
          include: {
            product: true
          }
        }
      }
    });

    await prisma.orderTimeline.create({
      data: {
        orderId: id,
        status: 'paid',
        title: 'Payment confirmed',
        message: 'Payment has been marked as received.',
        actorId: userId
      }
    }).catch(() => null);

    emitOrderUpdate(updated.buyerId, updated.storeId, 'order:payment_update', {
      orderId: updated.id,
      orderNumber: updated.orderNumber,
      paymentStatus: updated.paymentStatus,
      status: updated.status
    });

    return res.json(updated);
  } catch {
    return res.status(500).json({ error: 'Failed to update payment status' });
  }
};

export const getOrderAnalytics = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { storeId } = req.params;

    const store = await prisma.store.findFirst({
      where: {
        id: storeId,
        ownerId: userId
      }
    });

    if (!store) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [revenue, pending, completed, cancelled, ordersToday] = await Promise.all([
      prisma.order.aggregate({
        where: {
          storeId,
          paymentStatus: 'paid'
        },
        _sum: {
          total: true
        },
        _count: true
      }),
      prisma.order.count({
        where: {
          storeId,
          status: {
            in: ['pending', 'confirmed', 'processing', 'packed']
          }
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: 'delivered'
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: 'cancelled'
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      })
    ]);

    return res.json({
      totalRevenue: revenue._sum.total || 0,
      totalOrders: revenue._count || 0,
      pendingOrders: pending,
      completedOrders: completed,
      cancelledOrders: cancelled,
      ordersToday
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch order analytics' });
  }
};
