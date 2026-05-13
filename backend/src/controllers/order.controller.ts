import { Request, Response } from 'express';
import crypto from 'crypto';
import { OrderStatus, PaymentStatus, ProductStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { io } from '../app';

type AddressInput = Record<string, any> | string | null | undefined;

const ORDER_STATUS_VALUES = new Set(Object.values(OrderStatus));
const PAYMENT_METHODS = new Set(['cod', 'upi', 'card', 'wallet', 'netbanking']);

const parseJson = <T = any>(value: any, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
};

const normalizeMoney = (value: number) => Number(Math.max(0, value).toFixed(2));

const generateOrderNumber = () => `TXA-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const safeAddress = (address: AddressInput) => parseJson<Record<string, any>>(address, {});

const calculateTax = (subtotal: number) => normalizeMoney(subtotal * 0.08);

const calculateShipping = (items: any[]) => {
  const hasPhysical = items.some((item) => !item.product.isDigital);
  if (!hasPhysical) return 0;
  const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return normalizeMoney(49 + Math.max(0, quantity - 1) * 15);
};

const normalizeOrderStatus = (status: unknown): OrderStatus | null => {
  if (typeof status !== 'string') return null;
  const clean = status.trim().toUpperCase();
  return ORDER_STATUS_VALUES.has(clean as OrderStatus) ? (clean as OrderStatus) : null;
};

const safePage = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
};

const safeLimit = (value: unknown, fallback = 20, max = 50) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
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
                  isVerified: true
                }
              }
            }
          }
        },
        orderBy: {
          createdAt: 'asc'
        }
      }
    }
  });
};

const validateCartItems = (items: any[]) => {
  const invalid: string[] = [];

  for (const item of items) {
    if (!item.product) invalid.push(item.id);
    if (Number(item.quantity || 0) < 1) invalid.push(item.id);
    if (item.product?.status !== ProductStatus.ACTIVE) invalid.push(item.id);
    if (!item.product?.isDigital && Number(item.product?.inventory || 0) < Number(item.quantity || 0)) invalid.push(item.id);
  }

  return [...new Set(invalid)];
};

const buildOrderNote = (notes: unknown, couponCode?: unknown) => {
  const cleanNotes = typeof notes === 'string' && notes.trim() ? notes.trim() : '';
  const cleanCoupon = typeof couponCode === 'string' && couponCode.trim() ? couponCode.trim().toUpperCase() : '';
  if (cleanNotes && cleanCoupon) return `${cleanNotes}\nCoupon: ${cleanCoupon}`;
  if (cleanCoupon) return `Coupon: ${cleanCoupon}`;
  return cleanNotes || null;
};

const calculateDiscount = async (couponCode: unknown, subtotal: number) => {
  if (typeof couponCode !== 'string' || !couponCode.trim()) return 0;
  return normalizeMoney(subtotal * 0.1);
};

const canUpdateFromStatus = (status: OrderStatus) => {
  return ![OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.DELIVERED].includes(status);
};

const canCancelStatus = (status: OrderStatus) => {
  return [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING].includes(status);
};

const restoreInventoryForOrder = async (tx: any, items: any[]) => {
  for (const item of items) {
    const product = item.product;
    if (!product || product.isDigital) continue;

    await tx.product.update({
      where: { id: item.productId },
      data: {
        inventory: {
          increment: Number(item.quantity || 0)
        },
        salesCount: {
          decrement: Number(item.quantity || 0)
        }
      }
    }).catch(() => null);
  }
};

export const createOrder = async (req: Request, res: Response) => {
  try {
    const { shippingAddress, billingAddress, paymentMethod = 'cod', couponCode, notes } = req.body;
    const userId = req.userId!;

    const cleanPaymentMethod = String(paymentMethod || '').trim().toLowerCase();

    if (!PAYMENT_METHODS.has(cleanPaymentMethod)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment method'
      });
    }

    const cart = await getCartWithItems(userId);

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Cart is empty'
      });
    }

    const invalidItems = validateCartItems(cart.items);

    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Some cart items are unavailable or out of stock',
        invalidItems
      });
    }

    const parsedShippingAddress = safeAddress(shippingAddress);
    const parsedBillingAddress = safeAddress(billingAddress || shippingAddress);
    const storeIds = [...new Set(cart.items.map((item) => item.product.storeId))];

    const result = await prisma.$transaction(async (tx) => {
      const orders: any[] = [];

      for (const storeId of storeIds) {
        const storeItems = cart.items.filter((item) => item.product.storeId === storeId);

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

          if (!freshProduct || freshProduct.status !== ProductStatus.ACTIVE) {
            throw new Error(`Product unavailable: ${item.productId}`);
          }

          if (!freshProduct.isDigital && Number(freshProduct.inventory || 0) < Number(item.quantity || 0)) {
            throw new Error(`Insufficient stock: ${item.productId}`);
          }
        }

        const subtotal = normalizeMoney(storeItems.reduce((sum, item) => sum + Number(item.product.price || 0) * Number(item.quantity || 0), 0));
        const tax = calculateTax(subtotal);
        const shippingCost = calculateShipping(storeItems);
        const discount = await calculateDiscount(couponCode, subtotal);
        const total = normalizeMoney(subtotal + tax + shippingCost - discount);
        const orderNumber = generateOrderNumber();

        const order = await tx.order.create({
          data: {
            orderNumber,
            storeId,
            buyerId: userId,
            status: OrderStatus.PENDING,
            subtotal,
            shippingCost,
            tax,
            discount,
            total,
            currency: storeItems[0]?.product?.currency || 'USD',
            paymentMethod: cleanPaymentMethod,
            paymentStatus: cleanPaymentMethod === 'cod' ? PaymentStatus.PENDING : PaymentStatus.PENDING,
            shippingAddress: parsedShippingAddress,
            billingAddress: parsedBillingAddress,
            notes: buildOrderNote(notes, couponCode),
            items: {
              create: storeItems.map((item) => ({
                productId: item.productId,
                quantity: Number(item.quantity),
                price: Number(item.product.price),
                attributes: item.attributes || {}
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
          await tx.product.update({
            where: { id: item.productId },
            data: {
              ...(item.product.isDigital
                ? {}
                : {
                    inventory: {
                      decrement: Number(item.quantity)
                    }
                  }),
              salesCount: {
                increment: Number(item.quantity)
              }
            }
          });
        }

        await tx.commerceEvent.create({
          data: {
            userId,
            storeId,
            type: 'ORDER_CREATED',
            metadata: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              total: order.total,
              paymentMethod: cleanPaymentMethod
            }
          }
        }).catch(() => null);

        orders.push(order);
      }

      await tx.cartItem.deleteMany({
        where: {
          cartId: cart.id
        }
      });

      await tx.cart.update({
        where: {
          id: cart.id
        },
        data: {
          total: 0
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
        status: order.status,
        paymentStatus: order.paymentStatus
      });
    }

    io.to(`cart:${userId}`).emit('cart:updated', {
      id: cart.id,
      userId,
      items: [],
      total: 0,
      itemCount: 0,
      quantityTotal: 0
    });

    io.to(`user:${userId}`).emit('order:created', {
      orders: result
    });

    return res.status(201).json({
      success: true,
      status: 'created',
      orderCount: result.length,
      orders: result
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
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
            fullName: true,
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
            ownerId: true,
            isVerified: true
          }
        },
        reviews: true
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    if (order.buyerId !== userId && order.store.ownerId !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    return res.json({
      success: true,
      order
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch order'
    });
  }
};

export const getMyOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const skip = (page - 1) * limit;
    const status = normalizeOrderStatus(req.query.status);

    const where: any = {
      buyerId: userId,
      ...(status ? { status } : {})
    };

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
                  slug: true,
                  primaryMediaUrl: true,
                  price: true,
                  status: true
                }
              }
            }
          },
          store: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              isVerified: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take: limit
      }),
      prisma.order.count({ where })
    ]);

    return res.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + limit < total
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch orders'
    });
  }
};

export const getStoreOrders = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { storeId } = req.params;
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit);
    const skip = (page - 1) * limit;
    const status = normalizeOrderStatus(req.query.status);

    const store = await prisma.store.findFirst({
      where: {
        id: storeId,
        ownerId: userId
      },
      select: {
        id: true
      }
    });

    if (!store) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const where: any = {
      storeId,
      ...(status ? { status } : {})
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          buyer: {
            select: {
              id: true,
              username: true,
              fullName: true,
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
                  slug: true,
                  primaryMediaUrl: true,
                  price: true,
                  status: true
                }
              }
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take: limit
      }),
      prisma.order.count({ where })
    ]);

    return res.json({
      success: true,
      orders,
      pagination: {
        page,
        limit,
        total,
        hasMore: skip + limit < total
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch store orders'
    });
  }
};

export const updateOrderStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, trackingNumber, carrier, note } = req.body;
    const userId = req.userId!;
    const nextStatus = normalizeOrderStatus(status);

    if (!nextStatus) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order status'
      });
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
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!canUpdateFromStatus(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'Finalized order cannot be updated'
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id },
        data: {
          status: nextStatus,
          trackingNumber: typeof trackingNumber === 'string' && trackingNumber.trim() ? trackingNumber.trim() : undefined,
          carrier: typeof carrier === 'string' && carrier.trim() ? carrier.trim() : undefined,
          notes: typeof note === 'string' && note.trim() ? `${order.notes || ''}${order.notes ? '\n' : ''}Seller update: ${note.trim()}` : order.notes
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

      await tx.commerceEvent.create({
        data: {
          userId,
          storeId: order.storeId,
          type: 'ORDER_STATUS_UPDATED',
          metadata: {
            orderId: id,
            orderNumber: order.orderNumber,
            from: order.status,
            to: nextStatus,
            trackingNumber: trackingNumber || null,
            carrier: carrier || null
          }
        }
      }).catch(() => null);

      return next;
    });

    emitOrderUpdate(updated.buyerId, updated.storeId, 'order:status_update', {
      orderId: id,
      status: updated.status,
      orderNumber: updated.orderNumber,
      trackingNumber: updated.trackingNumber,
      carrier: updated.carrier
    });

    return res.json({
      success: true,
      order: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update order status'
    });
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
        items: {
          include: {
            product: true
          }
        },
        store: {
          select: {
            id: true,
            ownerId: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const canCancel = order.buyerId === userId || order.store.ownerId === userId;

    if (!canCancel) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (!canCancelStatus(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'Order cannot be cancelled now'
      });
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      await restoreInventoryForOrder(tx, order.items);

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.CANCELLED,
          paymentStatus: order.paymentStatus === PaymentStatus.CAPTURED ? PaymentStatus.REFUNDED : order.paymentStatus,
          notes: typeof reason === 'string' && reason.trim() ? `${order.notes || ''}${order.notes ? '\n' : ''}Cancellation reason: ${reason.trim()}` : order.notes
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

      await tx.commerceEvent.create({
        data: {
          userId,
          storeId: order.storeId,
          type: 'ORDER_CANCELLED',
          metadata: {
            orderId: id,
            orderNumber: order.orderNumber,
            reason: reason || null
          }
        }
      }).catch(() => null);

      return updated;
    });

    emitOrderUpdate(cancelled.buyerId, cancelled.storeId, 'order:cancelled', {
      orderId: cancelled.id,
      orderNumber: cancelled.orderNumber,
      reason: reason || null,
      status: cancelled.status,
      paymentStatus: cancelled.paymentStatus
    });

    return res.json({
      success: true,
      order: cancelled
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to cancel order'
    });
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
            id: true,
            ownerId: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    if (order.buyerId !== userId && order.store.ownerId !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if ([OrderStatus.CANCELLED, OrderStatus.REFUNDED].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark cancelled/refunded order as paid'
      });
    }

    const paymentNoteParts = [
      typeof transactionId === 'string' && transactionId.trim() ? `Transaction: ${transactionId.trim()}` : null,
      typeof paymentProvider === 'string' && paymentProvider.trim() ? `Provider: ${paymentProvider.trim()}` : null
    ].filter(Boolean);

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id },
        data: {
          paymentStatus: PaymentStatus.CAPTURED,
          status: order.status === OrderStatus.PENDING ? OrderStatus.CONFIRMED : order.status,
          notes: paymentNoteParts.length ? `${order.notes || ''}${order.notes ? '\n' : ''}${paymentNoteParts.join(' | ')}` : order.notes
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

      await tx.commerceEvent.create({
        data: {
          userId,
          storeId: order.storeId,
          type: 'ORDER_PAYMENT_CAPTURED',
          metadata: {
            orderId: id,
            orderNumber: order.orderNumber,
            transactionId: transactionId || null,
            paymentProvider: paymentProvider || null
          }
        }
      }).catch(() => null);

      return next;
    });

    emitOrderUpdate(updated.buyerId, updated.storeId, 'order:payment_update', {
      orderId: updated.id,
      orderNumber: updated.orderNumber,
      paymentStatus: updated.paymentStatus,
      status: updated.status
    });

    return res.json({
      success: true,
      order: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update payment status'
    });
  }
};

export const refundOrder = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.userId!;

    const order = await prisma.order.findFirst({
      where: {
        id,
        store: {
          ownerId: userId
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
            ownerId: true
          }
        }
      }
    });

    if (!order) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    if (![PaymentStatus.CAPTURED, PaymentStatus.AUTHORIZED].includes(order.paymentStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Order payment is not refundable'
      });
    }

    const refunded = await prisma.$transaction(async (tx) => {
      if (![OrderStatus.CANCELLED, OrderStatus.REFUNDED].includes(order.status)) {
        await restoreInventoryForOrder(tx, order.items);
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.REFUNDED,
          paymentStatus: PaymentStatus.REFUNDED,
          notes: typeof reason === 'string' && reason.trim() ? `${order.notes || ''}${order.notes ? '\n' : ''}Refund reason: ${reason.trim()}` : order.notes
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

      await tx.commerceEvent.create({
        data: {
          userId,
          storeId: order.storeId,
          type: 'ORDER_REFUNDED',
          metadata: {
            orderId: id,
            orderNumber: order.orderNumber,
            reason: reason || null
          }
        }
      }).catch(() => null);

      return updated;
    });

    emitOrderUpdate(refunded.buyerId, refunded.storeId, 'order:refunded', {
      orderId: refunded.id,
      orderNumber: refunded.orderNumber,
      status: refunded.status,
      paymentStatus: refunded.paymentStatus,
      reason: reason || null
    });

    return res.json({
      success: true,
      order: refunded
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to refund order'
    });
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
      },
      select: {
        id: true
      }
    });

    if (!store) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [revenue, pendingOrders, completedOrders, cancelledOrders, refundedOrders, ordersToday, totalOrders] = await Promise.all([
      prisma.order.aggregate({
        where: {
          storeId,
          paymentStatus: PaymentStatus.CAPTURED
        },
        _sum: {
          total: true
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: {
            in: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.SHIPPED]
          }
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: OrderStatus.DELIVERED
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: OrderStatus.CANCELLED
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          status: OrderStatus.REFUNDED
        }
      }),
      prisma.order.count({
        where: {
          storeId,
          createdAt: {
            gte: todayStart
          }
        }
      }),
      prisma.order.count({
        where: {
          storeId
        }
      })
    ]);

    return res.json({
      success: true,
      analytics: {
        totalRevenue: revenue._sum.total || 0,
        totalOrders,
        pendingOrders,
        completedOrders,
        cancelledOrders,
        refundedOrders,
        ordersToday
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch order analytics'
    });
  }
};
