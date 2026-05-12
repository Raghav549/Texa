import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadToCloudinary } from '../utils/media';
import { calculateTrustScore } from '../services/trustAlgorithm';
import { io } from '../app';

type StoreFileMap = {
  logo?: Express.Multer.File[];
  banner?: Express.Multer.File[];
  gallery?: Express.Multer.File[];
};

const STORE_STATUS_DISABLED = 'disabled';
const STORE_DEFAULT_LIMIT = 20;
const STORE_MAX_LIMIT = 50;
const STORE_MAX_GALLERY = 12;
const STORE_SLUG_MIN = 3;
const STORE_SLUG_MAX = 64;

const safeJson = <T = any>(value: any, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const cleanText = (value: any, max = 500) => {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
};

const normalizeSlug = (value: any, fallback?: string) => {
  const base = cleanText(value, STORE_SLUG_MAX) || cleanText(fallback, STORE_SLUG_MAX) || `store-${Date.now()}`;
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STORE_SLUG_MAX);
  return slug.length >= STORE_SLUG_MIN ? slug : `store-${slug}-${Date.now()}`;
};

const uniqueSlug = async (baseSlug: string, storeId?: string) => {
  let slug = baseSlug;
  let count = 1;
  while (true) {
    const existing = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
    if (!existing || existing.id === storeId) return slug;
    count += 1;
    const suffix = `-${count}`;
    slug = `${baseSlug.slice(0, STORE_SLUG_MAX - suffix.length)}${suffix}`;
  }
};

const parseBool = (value: any, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
};

const parseLimit = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return STORE_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), STORE_MAX_LIMIT);
};

const pickSort = (sort: any) => {
  const allowed: Record<string, any> = {
    rating: { rating: 'desc' },
    trust: { trustScore: 'desc' },
    newest: { createdAt: 'desc' },
    products: { productsCount: 'desc' },
    orders: { ordersCount: 'desc' },
    reviews: { reviewsCount: 'desc' }
  };
  return allowed[String(sort || '').toLowerCase()] || allowed.rating;
};

const getFiles = (req: Request) => (req.files || {}) as StoreFileMap;

const uploadFile = async (file: Express.Multer.File, folder: string) => {
  const result = await uploadToCloudinary(file, folder, {
    resource_type: 'auto',
    transformation: [{ quality: 'auto:good', fetch_format: 'auto' }]
  });
  return typeof result === 'string' ? result : result?.secure_url || result?.url || '';
};

const buildStorePayload = (body: any, slug?: string) => {
  const name = cleanText(body.name, 120);
  const description = cleanText(body.description, 2000);
  const address = safeJson(body.address, body.address || null);
  const contact = safeJson(body.contact, body.contact || null);
  const socialLinks = safeJson(body.socialLinks, body.socialLinks || {});
  const settings = safeJson(body.settings, body.settings || {});
  const theme = safeJson(body.theme, body.theme || {});
  const category = cleanText(body.category, 80);
  const tags = safeJson<string[]>(body.tags, []);
  const serviceAreas = safeJson<string[]>(body.serviceAreas, []);
  const businessHours = safeJson(body.businessHours, {});
  const policies = safeJson(body.policies, {});
  const features = safeJson<string[]>(body.features, []);
  const metadata = safeJson(body.metadata, {});
  const payload: any = {};
  if (name) payload.name = name;
  if (slug) payload.slug = slug;
  if (description !== undefined) payload.description = description;
  if (address !== undefined) payload.address = address;
  if (contact !== undefined) payload.contact = contact;
  if (socialLinks !== undefined) payload.socialLinks = socialLinks;
  if (settings !== undefined) payload.settings = settings;
  if (theme !== undefined) payload.theme = theme;
  if (category !== undefined) payload.category = category;
  if (Array.isArray(tags)) payload.tags = tags.map(t => cleanText(t, 40)).filter(Boolean).slice(0, 20);
  if (Array.isArray(serviceAreas)) payload.serviceAreas = serviceAreas.map(a => cleanText(a, 80)).filter(Boolean).slice(0, 30);
  if (businessHours !== undefined) payload.businessHours = businessHours;
  if (policies !== undefined) payload.policies = policies;
  if (Array.isArray(features)) payload.features = features.map(f => cleanText(f, 60)).filter(Boolean).slice(0, 30);
  if (metadata !== undefined) payload.metadata = metadata;
  if (body.status) payload.status = cleanText(body.status, 30);
  if (body.currency) payload.currency = cleanText(body.currency, 10);
  if (body.language) payload.language = cleanText(body.language, 10);
  if (body.timezone) payload.timezone = cleanText(body.timezone, 80);
  return payload;
};

const assertStoreOwner = async (storeId: string, userId: string) => {
  const store = await prisma.store.findFirst({ where: { id: storeId, ownerId: userId } });
  return store;
};

export const createStore = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const name = cleanText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Store name is required' });

    const baseSlug = normalizeSlug(req.body.slug, name);
    const slug = await uniqueSlug(baseSlug);
    const isBusiness = parseBool(req.body.isBusiness);
    const files = getFiles(req);
    const payload = buildStorePayload(req.body, slug);

    const [logoUrl, bannerUrl] = await Promise.all([
      files.logo?.[0] ? uploadFile(files.logo[0], 'stores/logos') : Promise.resolve(undefined),
      files.banner?.[0] ? uploadFile(files.banner[0], 'stores/banners') : Promise.resolve(undefined)
    ]);

    const galleryFiles = files.gallery?.slice(0, STORE_MAX_GALLERY) || [];
    const galleryUrls = await Promise.all(galleryFiles.map(file => uploadFile(file, 'stores/gallery')));

    const store = await prisma.$transaction(async tx => {
      const created = await tx.store.create({
        data: {
          ownerId: userId,
          ...payload,
          logoUrl,
          bannerUrl,
          galleryUrls: galleryUrls.filter(Boolean),
          isVerified: isBusiness,
          verificationStatus: isBusiness ? 'verified' : 'pending',
          status: 'active',
          trustScore: 0,
          rating: 0,
          productsCount: 0,
          ordersCount: 0,
          reviewsCount: 0
        }
      });

      if (isBusiness) {
        await tx.businessProfile.upsert({
          where: { userId },
          update: { businessName: name, verificationStatus: 'verified', storeId: created.id },
          create: { userId, businessName: name, verificationStatus: 'verified', storeId: created.id }
        });
      }

      return created;
    });

    await calculateTrustScore(store.id).catch(() => null);
    io.to('stores').emit('store:created', { storeId: store.id, slug: store.slug, ownerId: userId });
    io.to(`user:${userId}`).emit('store:created', store);

    res.status(201).json(store);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to create store' });
  }
};

export const updateStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await assertStoreOwner(id, userId);
    if (!store) return res.status(403).json({ error: 'Access denied' });

    const files = getFiles(req);
    const updateData: any = buildStorePayload(req.body);

    if (req.body.slug) updateData.slug = await uniqueSlug(normalizeSlug(req.body.slug, updateData.name || store.name), id);
    if (files.logo?.[0]) updateData.logoUrl = await uploadFile(files.logo[0], 'stores/logos');
    if (files.banner?.[0]) updateData.bannerUrl = await uploadFile(files.banner[0], 'stores/banners');

    if (files.gallery?.length) {
      const galleryUrls = await Promise.all(files.gallery.slice(0, STORE_MAX_GALLERY).map(file => uploadFile(file, 'stores/gallery')));
      const existing = Array.isArray((store as any).galleryUrls) ? (store as any).galleryUrls : [];
      updateData.galleryUrls = [...existing, ...galleryUrls.filter(Boolean)].slice(0, STORE_MAX_GALLERY);
    }

    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'No valid update fields provided' });

    const updated = await prisma.store.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { products: true, orders: true, reviews: true } }
      }
    });

    await calculateTrustScore(id).catch(() => null);
    io.to('stores').emit('store:updated', { storeId: id, updates: updateData });
    io.to(`store:${id}`).emit('store:updated', updated);
    io.to(`user:${userId}`).emit('store:updated', updated);

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update store' });
  }
};

export const getStore = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const viewerId = req.userId;
    const store = await prisma.store.findUnique({
      where: { slug },
      include: {
        owner: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        products: {
          where: { status: 'active' },
          take: 12,
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, slug: true, price: true, salePrice: true, images: true, rating: true, salesCount: true }
        },
        _count: { select: { products: true, orders: true, reviews: true } },
        reviews: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { buyer: { select: { id: true, username: true, avatarUrl: true, isVerified: true } } }
        }
      }
    });

    if (!store || store.status === STORE_STATUS_DISABLED) return res.status(404).json({ error: 'Store not found' });

    const isOwner = viewerId === store.ownerId;
    const sanitized = {
      ...store,
      privateNotes: isOwner ? (store as any).privateNotes : undefined,
      payoutSettings: isOwner ? (store as any).payoutSettings : undefined,
      internalFlags: undefined,
      isOwner
    };

    res.json(sanitized);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch store' });
  }
};

export const searchStores = async (req: Request, res: Response) => {
  try {
    const { q, category, minTrust, sort = 'rating', cursor } = req.query;
    const limit = parseLimit(req.query.limit);
    const where: any = { isVerified: true, status: { not: STORE_STATUS_DISABLED } };

    if (q) {
      const query = String(q).trim();
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { tags: { has: query.toLowerCase() } },
        { category: { contains: query, mode: 'insensitive' } }
      ];
    }

    if (category) where.category = { equals: String(category), mode: 'insensitive' };
    if (minTrust) where.trustScore = { gte: Number(minTrust) || 0 };

    const stores = await prisma.store.findMany({
      where,
      orderBy: pickSort(sort),
      cursor: cursor ? { id: String(cursor) } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1,
      include: {
        owner: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        _count: { select: { products: true, reviews: true } }
      }
    });

    const hasMore = stores.length > limit;
    const result = hasMore ? stores.slice(0, -1) : stores;
    const nextCursor = hasMore ? result[result.length - 1]?.id : null;

    res.json({ stores: result, nextCursor, hasMore });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to search stores' });
  }
};

export const getMyStores = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const stores = await prisma.store.findMany({
      where: { ownerId: userId, status: { not: STORE_STATUS_DISABLED } },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { products: true, orders: true, reviews: true } }
      }
    });
    res.json(stores);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch stores' });
  }
};

export const followStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { remove = false } = req.body;
    const userId = req.userId!;
    const store = await prisma.store.findUnique({ where: { id }, select: { id: true, ownerId: true, followers: true } });
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const followers = Array.isArray((store as any).followers) ? (store as any).followers : [];
    const nextFollowers = remove ? followers.filter((uid: string) => uid !== userId) : Array.from(new Set([...followers, userId]));

    const updated = await prisma.store.update({
      where: { id },
      data: { followers: nextFollowers },
      select: { id: true, followers: true }
    });

    if (!remove && store.ownerId !== userId) {
      io.to(`user:${store.ownerId}`).emit('notification:store_follow', { storeId: id, from: userId, timestamp: new Date() });
    }

    io.to(`store:${id}`).emit('store:followers', { storeId: id, count: updated.followers.length });
    res.json({ status: remove ? 'unfollowed' : 'followed', count: updated.followers.length });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update follow status' });
  }
};

export const reviewStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const rating = Math.max(1, Math.min(5, Number(req.body.rating)));
    const comment = cleanText(req.body.comment, 1000) || '';

    if (!Number.isFinite(rating)) return res.status(400).json({ error: 'Valid rating is required' });

    const store = await prisma.store.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.ownerId === userId) return res.status(400).json({ error: 'You cannot review your own store' });

    const review = await prisma.storeReview.upsert({
      where: { storeId_buyerId: { storeId: id, buyerId: userId } },
      update: { rating, comment },
      create: { storeId: id, buyerId: userId, rating, comment },
      include: { buyer: { select: { id: true, username: true, avatarUrl: true, isVerified: true } } }
    });

    const stats = await prisma.storeReview.aggregate({
      where: { storeId: id },
      _avg: { rating: true },
      _count: true
    });

    await prisma.store.update({
      where: { id },
      data: {
        rating: Number((stats._avg.rating || 0).toFixed(2)),
        reviewsCount: stats._count
      }
    });

    await calculateTrustScore(id).catch(() => null);
    io.to(`store:${id}`).emit('store:reviewed', review);
    io.to(`user:${store.ownerId}`).emit('notification:store_review', { storeId: id, from: userId, rating, timestamp: new Date() });

    res.status(201).json(review);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to review store' });
  }
};

export const deleteStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await assertStoreOwner(id, userId);
    if (!store) return res.status(403).json({ error: 'Access denied' });

    await prisma.store.update({ where: { id }, data: { status: STORE_STATUS_DISABLED, disabledAt: new Date() } });
    io.to('stores').emit('store:disabled', { storeId: id });
    io.to(`store:${id}`).emit('store:disabled', { storeId: id });

    res.json({ status: 'disabled' });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to disable store' });
  }
};

export const getStoreAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await prisma.store.findFirst({ where: { id, ownerId: userId } });
    if (!store) return res.status(403).json({ error: 'Access denied' });

    const now = new Date();
    const start30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const start7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      orders,
      orders7,
      products,
      reviews,
      adPerformance,
      topProducts,
      recentOrders,
      dailyRevenue,
      followerCount
    ] = await Promise.all([
      prisma.order.aggregate({ where: { storeId: id }, _sum: { total: true }, _count: true }),
      prisma.order.aggregate({ where: { storeId: id, createdAt: { gte: start7 } }, _sum: { total: true }, _count: true }),
      prisma.product.aggregate({ where: { storeId: id }, _sum: { salesCount: true, viewCount: true }, _count: true }),
      prisma.storeReview.aggregate({ where: { storeId: id }, _avg: { rating: true }, _count: true }),
      prisma.advertisement.aggregate({ where: { storeId: id }, _sum: { impressions: true, clicks: true, conversions: true, spend: true } }),
      prisma.product.findMany({
        where: { storeId: id },
        orderBy: { salesCount: 'desc' },
        take: 5,
        select: { id: true, name: true, slug: true, images: true, salesCount: true, viewCount: true, price: true }
      }),
      prisma.order.findMany({
        where: { storeId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, total: true, status: true, createdAt: true }
      }),
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COALESCE(SUM(total), 0) as revenue, COUNT(*) as orders
        FROM "Order"
        WHERE "storeId" = ${id}
        AND "createdAt" >= ${start30}
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `,
      Promise.resolve(Array.isArray((store as any).followers) ? (store as any).followers.length : 0)
    ]);

    const impressions = Number(adPerformance._sum.impressions || 0);
    const clicks = Number(adPerformance._sum.clicks || 0);
    const conversions = Number(adPerformance._sum.conversions || 0);
    const spend = Number((adPerformance._sum as any).spend || 0);
    const revenue = Number(orders._sum.total || 0);
    const revenue7 = Number(orders7._sum.total || 0);

    res.json({
      store,
      revenue,
      revenue7,
      orderCount: orders._count || 0,
      orderCount7: orders7._count || 0,
      productSales: products._sum.salesCount || 0,
      productViews: products._sum.viewCount || 0,
      productCount: products._count || 0,
      avgRating: Number((reviews._avg.rating || 0).toFixed(2)),
      reviewsCount: reviews._count || 0,
      followerCount,
      conversionRate: products._sum.viewCount ? Number(((Number(products._sum.salesCount || 0) / Number(products._sum.viewCount || 1)) * 100).toFixed(2)) : 0,
      adMetrics: {
        impressions,
        clicks,
        conversions,
        spend,
        ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
        cvr: clicks ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
        cpa: conversions ? Number((spend / conversions).toFixed(2)) : 0
      },
      topProducts,
      recentOrders,
      dailyRevenue
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch store analytics' });
  }
};
