import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadToCloudinary } from '../utils/media';
import { io } from '../app';

type UploadedFiles = {
  media?: Express.Multer.File[];
};

const MAX_PRODUCT_MEDIA = 12;
const MAX_LIMIT = 50;
const PRODUCT_STATUSES = new Set(['draft', 'active', 'archived', 'disabled']);
const SORT_MAP: Record<string, any> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  price_high: { price: 'desc' },
  price_low: { price: 'asc' },
  popular: { viewCount: 'desc' },
  sales: { salesCount: 'desc' },
  rating: { rating: 'desc' },
  inventory: { inventory: 'desc' },
  updated: { updatedAt: 'desc' },
  createdAt: { createdAt: 'desc' }
};

const cleanText = (value: any, max = 5000) => {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
};

const cleanSlug = (value: any, fallback: string) => {
  const raw = typeof value === 'string' && value.trim() ? value : fallback;
  return raw
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `product-${Date.now()}`;
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

const toNumber = (value: any, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBoolean = (value: any, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
};

const getFiles = (req: Request): UploadedFiles => {
  const files = req.files as any;
  if (!files) return {};
  if (Array.isArray(files)) return { media: files };
  return files;
};

const uploadMediaFiles = async (files: Express.Multer.File[] = []) => {
  const selected = files.slice(0, MAX_PRODUCT_MEDIA);
  const uploads = await Promise.all(selected.map(file => uploadToCloudinary(file, 'products', { resource_type: 'auto' })));
  return uploads.map((item: any) => item?.secure_url || item?.url || item).filter(Boolean);
};

const createUniqueProductSlug = async (storeId: string, baseSlug: string, ignoreProductId?: string) => {
  let slug = baseSlug;
  let index = 2;

  while (true) {
    const existing = await prisma.product.findFirst({
      where: {
        storeId,
        slug,
        ...(ignoreProductId ? { id: { not: ignoreProductId } } : {})
      },
      select: { id: true }
    });

    if (!existing) return slug;
    slug = `${baseSlug}-${index}`;
    index += 1;
  }
};

const assertStoreOwner = async (storeId: string, userId: string) => {
  const store = await prisma.store.findFirst({
    where: { id: storeId, ownerId: userId, status: { not: 'disabled' } },
    select: { id: true, ownerId: true, slug: true, name: true }
  });

  return store;
};

const assertProductOwner = async (productId: string, userId: string) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: {
        select: { id: true, ownerId: true, slug: true, name: true }
      }
    }
  });

  if (!product || product.store.ownerId !== userId) return null;
  return product;
};

const sanitizeProductForPublic = (product: any) => {
  if (!product) return product;
  return {
    ...product,
    internalNotes: undefined,
    supplierCost: undefined,
    supplierInfo: undefined,
    fraudScore: undefined
  };
};

export const createProduct = async (req: Request, res: Response) => {
  try {
    const {
      storeId,
      name,
      slug,
      description,
      shortDescription,
      price,
      compareAtPrice,
      costPrice,
      sku,
      barcode,
      inventory,
      lowStockThreshold,
      categoryIds,
      collectionIds,
      tags,
      attributes,
      variants,
      options,
      seoTitle,
      seoDescription,
      isDigital,
      digitalFileUrl,
      shippingWeight,
      shippingDimensions,
      status,
      visibility,
      allowReviews,
      allowCOD,
      isFeatured,
      taxCode,
      metadata
    } = req.body;

    const userId = req.userId!;
    const store = await assertStoreOwner(storeId, userId);

    if (!store) return res.status(403).json({ error: 'Store access denied' });

    const productName = cleanText(name, 140);
    if (!productName) return res.status(400).json({ error: 'Product name required' });

    const productPrice = toNumber(price, NaN);
    if (!Number.isFinite(productPrice) || productPrice < 0) return res.status(400).json({ error: 'Valid product price required' });

    const productStatus = PRODUCT_STATUSES.has(status) ? status : 'draft';
    const baseSlug = cleanSlug(slug, productName);
    const uniqueSlug = await createUniqueProductSlug(storeId, baseSlug);
    const files = getFiles(req);
    const mediaUrls = await uploadMediaFiles(files.media || []);

    const product = await prisma.product.create({
      data: {
        storeId,
        name: productName,
        slug: uniqueSlug,
        description: cleanText(description, 12000) || '',
        shortDescription: cleanText(shortDescription, 300) || null,
        price: productPrice,
        compareAtPrice: compareAtPrice !== undefined && compareAtPrice !== '' ? toNumber(compareAtPrice, 0) : null,
        costPrice: costPrice !== undefined && costPrice !== '' ? toNumber(costPrice, 0) : null,
        sku: cleanText(sku, 80) || null,
        barcode: cleanText(barcode, 80) || null,
        inventory: Math.max(0, Math.floor(toNumber(inventory, 0))),
        lowStockThreshold: Math.max(0, Math.floor(toNumber(lowStockThreshold, 5))),
        mediaUrls,
        primaryMediaUrl: mediaUrls[0] || '',
        categoryIds: safeJson<string[]>(categoryIds, []),
        collectionIds: safeJson<string[]>(collectionIds, []),
        tags: safeJson<string[]>(tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30),
        attributes: safeJson<Record<string, any>>(attributes, {}),
        variants: safeJson<any[]>(variants, []),
        options: safeJson<any[]>(options, []),
        seoTitle: cleanText(seoTitle, 70) || productName,
        seoDescription: cleanText(seoDescription, 170) || cleanText(description, 170) || '',
        isDigital: toBoolean(isDigital, false),
        digitalFileUrl: cleanText(digitalFileUrl, 1000) || null,
        shippingWeight: Math.max(0, toNumber(shippingWeight, 0)),
        shippingDimensions: safeJson<Record<string, any>>(shippingDimensions, {}),
        status: productStatus,
        visibility: visibility || 'public',
        allowReviews: toBoolean(allowReviews, true),
        allowCOD: toBoolean(allowCOD, true),
        isFeatured: toBoolean(isFeatured, false),
        taxCode: cleanText(taxCode, 80) || null,
        metadata: safeJson<Record<string, any>>(metadata, {}),
        viewCount: 0,
        salesCount: 0,
        rating: 0,
        reviewsCount: 0
      }
    });

    await prisma.store.update({
      where: { id: storeId },
      data: { productsCount: { increment: 1 } }
    }).catch(() => null);

    io.to(`store:${storeId}`).emit('product:new', { productId: product.id, storeId });
    io.to('products').emit('product:created', { productId: product.id, storeId, status: product.status });

    return res.status(201).json(product);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to create product' });
  }
};

export const updateProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) return res.status(403).json({ error: 'Access denied' });

    const updateData: any = {};
    const files = getFiles(req);

    if (files.media?.length) {
      const newUrls = await uploadMediaFiles(files.media);
      const existingUrls = Array.isArray(product.mediaUrls) ? product.mediaUrls : [];
      const merged = [...existingUrls, ...newUrls].slice(0, MAX_PRODUCT_MEDIA);
      updateData.mediaUrls = merged;
      updateData.primaryMediaUrl = product.primaryMediaUrl || merged[0] || '';
    }

    const {
      name,
      slug,
      description,
      shortDescription,
      price,
      compareAtPrice,
      costPrice,
      sku,
      barcode,
      inventory,
      lowStockThreshold,
      categoryIds,
      collectionIds,
      tags,
      attributes,
      variants,
      options,
      seoTitle,
      seoDescription,
      isDigital,
      digitalFileUrl,
      shippingWeight,
      shippingDimensions,
      status,
      visibility,
      allowReviews,
      allowCOD,
      isFeatured,
      taxCode,
      metadata,
      primaryMediaUrl,
      removeMediaUrls
    } = req.body;

    if (name !== undefined) {
      const cleanedName = cleanText(name, 140);
      if (!cleanedName) return res.status(400).json({ error: 'Product name cannot be empty' });
      updateData.name = cleanedName;
    }

    if (slug !== undefined || name !== undefined) {
      const baseSlug = cleanSlug(slug, updateData.name || product.name);
      updateData.slug = await createUniqueProductSlug(product.storeId, baseSlug, id);
    }

    if (description !== undefined) updateData.description = cleanText(description, 12000) || '';
    if (shortDescription !== undefined) updateData.shortDescription = cleanText(shortDescription, 300) || null;
    if (price !== undefined) {
      const n = toNumber(price, NaN);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Valid product price required' });
      updateData.price = n;
    }
    if (compareAtPrice !== undefined) updateData.compareAtPrice = compareAtPrice === '' ? null : toNumber(compareAtPrice, 0);
    if (costPrice !== undefined) updateData.costPrice = costPrice === '' ? null : toNumber(costPrice, 0);
    if (sku !== undefined) updateData.sku = cleanText(sku, 80) || null;
    if (barcode !== undefined) updateData.barcode = cleanText(barcode, 80) || null;
    if (inventory !== undefined) updateData.inventory = Math.max(0, Math.floor(toNumber(inventory, 0)));
    if (lowStockThreshold !== undefined) updateData.lowStockThreshold = Math.max(0, Math.floor(toNumber(lowStockThreshold, 5)));
    if (categoryIds !== undefined) updateData.categoryIds = safeJson<string[]>(categoryIds, []);
    if (collectionIds !== undefined) updateData.collectionIds = safeJson<string[]>(collectionIds, []);
    if (tags !== undefined) updateData.tags = safeJson<string[]>(tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30);
    if (attributes !== undefined) updateData.attributes = safeJson<Record<string, any>>(attributes, {});
    if (variants !== undefined) updateData.variants = safeJson<any[]>(variants, []);
    if (options !== undefined) updateData.options = safeJson<any[]>(options, []);
    if (seoTitle !== undefined) updateData.seoTitle = cleanText(seoTitle, 70) || null;
    if (seoDescription !== undefined) updateData.seoDescription = cleanText(seoDescription, 170) || null;
    if (isDigital !== undefined) updateData.isDigital = toBoolean(isDigital, product.isDigital);
    if (digitalFileUrl !== undefined) updateData.digitalFileUrl = cleanText(digitalFileUrl, 1000) || null;
    if (shippingWeight !== undefined) updateData.shippingWeight = Math.max(0, toNumber(shippingWeight, 0));
    if (shippingDimensions !== undefined) updateData.shippingDimensions = safeJson<Record<string, any>>(shippingDimensions, {});
    if (status !== undefined) {
      if (!PRODUCT_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid product status' });
      updateData.status = status;
    }
    if (visibility !== undefined) updateData.visibility = visibility;
    if (allowReviews !== undefined) updateData.allowReviews = toBoolean(allowReviews, true);
    if (allowCOD !== undefined) updateData.allowCOD = toBoolean(allowCOD, true);
    if (isFeatured !== undefined) updateData.isFeatured = toBoolean(isFeatured, false);
    if (taxCode !== undefined) updateData.taxCode = cleanText(taxCode, 80) || null;
    if (metadata !== undefined) updateData.metadata = safeJson<Record<string, any>>(metadata, {});

    if (removeMediaUrls !== undefined) {
      const removeList = new Set(safeJson<string[]>(removeMediaUrls, []));
      const current = Array.isArray(updateData.mediaUrls) ? updateData.mediaUrls : product.mediaUrls || [];
      updateData.mediaUrls = current.filter((url: string) => !removeList.has(url));
      if (removeList.has(product.primaryMediaUrl)) updateData.primaryMediaUrl = updateData.mediaUrls[0] || '';
    }

    if (primaryMediaUrl !== undefined) {
      const mediaList = Array.isArray(updateData.mediaUrls) ? updateData.mediaUrls : product.mediaUrls || [];
      if (mediaList.includes(primaryMediaUrl)) updateData.primaryMediaUrl = primaryMediaUrl;
    }

    const updated = await prisma.product.update({
      where: { id },
      data: updateData
    });

    io.to(`store:${product.storeId}`).emit('product:updated', { productId: id, storeId: product.storeId });
    io.to(`product:${id}`).emit('product:updated', { productId: id });

    return res.json(updated);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to update product' });
  }
};

export const getProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.userId;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            isVerified: true,
            logoUrl: true,
            trustScore: true,
            rating: true,
            reviewsCount: true,
            ownerId: true
          }
        },
        reviews: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: {
            buyer: {
              select: { id: true, username: true, avatarUrl: true, isVerified: true }
            }
          }
        },
        _count: {
          select: { reviews: true }
        }
      }
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });

    const isOwner = viewerId && product.store.ownerId === viewerId;

    if (!isOwner && (product.status !== 'active' || product.visibility !== 'public')) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await prisma.product.update({
      where: { id },
      data: { viewCount: { increment: 1 } }
    }).catch(() => null);

    io.to(`product:${id}`).emit('product:viewed', { productId: id });

    return res.json(sanitizeProductForPublic(product));
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch product' });
  }
};

export const getStoreProducts = async (req: Request, res: Response) => {
  try {
    const { storeId } = req.params;
    const {
      page = 1,
      limit = 20,
      category,
      collection,
      q,
      minPrice,
      maxPrice,
      inStock,
      featured,
      sort = 'newest',
      includeDrafts
    } = req.query;

    const userId = req.userId;
    const pageNum = Math.max(1, Number(page) || 1);
    const take = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 20));

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ownerId: true, status: true }
    });

    if (!store || store.status === 'disabled') return res.status(404).json({ error: 'Store not found' });

    const isOwner = userId && store.ownerId === userId;

    const where: any = {
      storeId,
      ...(isOwner && includeDrafts === 'true' ? { status: { not: 'disabled' } } : { status: 'active', visibility: 'public' })
    };

    if (category) where.categoryIds = { has: String(category) };
    if (collection) where.collectionIds = { has: String(collection) };
    if (q) {
      where.OR = [
        { name: { contains: String(q), mode: 'insensitive' } },
        { description: { contains: String(q), mode: 'insensitive' } },
        { tags: { has: String(q).toLowerCase() } },
        { sku: { contains: String(q), mode: 'insensitive' } }
      ];
    }
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = toNumber(minPrice, 0);
      if (maxPrice) where.price.lte = toNumber(maxPrice, Number.MAX_SAFE_INTEGER);
    }
    if (inStock === 'true') where.inventory = { gt: 0 };
    if (featured === 'true') where.isFeatured = true;

    const orderBy = SORT_MAP[String(sort)] || SORT_MAP.newest;

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip: (pageNum - 1) * take,
        take,
        include: {
          store: {
            select: { id: true, name: true, slug: true, logoUrl: true, isVerified: true, trustScore: true }
          },
          _count: {
            select: { reviews: true }
          }
        }
      }),
      prisma.product.count({ where })
    ]);

    return res.json({
      products: products.map(sanitizeProductForPublic),
      pagination: {
        page: pageNum,
        limit: take,
        total,
        hasMore: pageNum * take < total,
        nextPage: pageNum * take < total ? pageNum + 1 : null
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch products' });
  }
};

export const searchProducts = async (req: Request, res: Response) => {
  try {
    const {
      q,
      storeId,
      category,
      collection,
      tag,
      minPrice,
      maxPrice,
      inStock,
      featured,
      verifiedStore,
      sort = 'newest',
      cursor,
      limit = 20
    } = req.query;

    const take = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 20));

    const where: any = {
      status: 'active',
      visibility: 'public',
      store: { status: { not: 'disabled' } }
    };

    if (storeId) where.storeId = String(storeId);
    if (category) where.categoryIds = { has: String(category) };
    if (collection) where.collectionIds = { has: String(collection) };
    if (tag) where.tags = { has: String(tag).toLowerCase() };
    if (q) {
      where.OR = [
        { name: { contains: String(q), mode: 'insensitive' } },
        { description: { contains: String(q), mode: 'insensitive' } },
        { tags: { has: String(q).toLowerCase() } },
        { sku: { contains: String(q), mode: 'insensitive' } }
      ];
    }
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = toNumber(minPrice, 0);
      if (maxPrice) where.price.lte = toNumber(maxPrice, Number.MAX_SAFE_INTEGER);
    }
    if (inStock === 'true') where.inventory = { gt: 0 };
    if (featured === 'true') where.isFeatured = true;
    if (verifiedStore === 'true') where.store.isVerified = true;

    const products = await prisma.product.findMany({
      where,
      orderBy: SORT_MAP[String(sort)] || SORT_MAP.newest,
      take: take + 1,
      ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            isVerified: true,
            trustScore: true,
            rating: true
          }
        },
        _count: {
          select: { reviews: true }
        }
      }
    });

    const hasMore = products.length > take;
    const items = hasMore ? products.slice(0, take) : products;

    return res.json({
      products: items.map(sanitizeProductForPublic),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      hasMore
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to search products' });
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) return res.status(403).json({ error: 'Access denied' });

    await prisma.product.update({
      where: { id },
      data: { status: 'disabled', visibility: 'private' }
    });

    await prisma.store.update({
      where: { id: product.storeId },
      data: { productsCount: { decrement: 1 } }
    }).catch(() => null);

    io.to(`store:${product.storeId}`).emit('product:disabled', { productId: id, storeId: product.storeId });
    io.to(`product:${id}`).emit('product:disabled', { productId: id });

    return res.json({ status: 'deleted' });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to delete product' });
  }
};

export const restoreProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) return res.status(403).json({ error: 'Access denied' });

    const restored = await prisma.product.update({
      where: { id },
      data: { status: 'draft', visibility: 'private' }
    });

    await prisma.store.update({
      where: { id: product.storeId },
      data: { productsCount: { increment: 1 } }
    }).catch(() => null);

    io.to(`store:${product.storeId}`).emit('product:restored', { productId: id, storeId: product.storeId });

    return res.json(restored);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to restore product' });
  }
};

export const setProductPrimaryMedia = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { mediaUrl } = req.body;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) return res.status(403).json({ error: 'Access denied' });
    if (!product.mediaUrls?.includes(mediaUrl)) return res.status(400).json({ error: 'Media not found in product' });

    const updated = await prisma.product.update({
      where: { id },
      data: { primaryMediaUrl: mediaUrl }
    });

    io.to(`store:${product.storeId}`).emit('product:updated', { productId: id, storeId: product.storeId });

    return res.json(updated);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to set primary media' });
  }
};

export const reviewProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rating, title, content, mediaUrls } = req.body;
    const userId = req.userId!;

    const product = await prisma.product.findUnique({
      where: { id },
      include: { store: { select: { ownerId: true, id: true } } }
    });

    if (!product || product.status !== 'active') return res.status(404).json({ error: 'Product not found' });
    if (product.store.ownerId === userId) return res.status(400).json({ error: 'Cannot review own product' });
    if (product.allowReviews === false) return res.status(400).json({ error: 'Reviews disabled for this product' });

    const cleanRating = Math.min(5, Math.max(1, Math.floor(toNumber(rating, 5))));

    const review = await prisma.productReview.upsert({
      where: { productId_buyerId: { productId: id, buyerId: userId } },
      update: {
        rating: cleanRating,
        title: cleanText(title, 120) || null,
        content: cleanText(content, 3000) || '',
        mediaUrls: safeJson<string[]>(mediaUrls, []),
        status: 'published'
      },
      create: {
        productId: id,
        buyerId: userId,
        rating: cleanRating,
        title: cleanText(title, 120) || null,
        content: cleanText(content, 3000) || '',
        mediaUrls: safeJson<string[]>(mediaUrls, []),
        status: 'published'
      }
    });

    const aggregate = await prisma.productReview.aggregate({
      where: { productId: id, status: 'published' },
      _avg: { rating: true },
      _count: true
    });

    await prisma.product.update({
      where: { id },
      data: {
        rating: aggregate._avg.rating || 0,
        reviewsCount: aggregate._count || 0
      }
    });

    io.to(`product:${id}`).emit('product:reviewed', { productId: id, rating: aggregate._avg.rating || 0 });
    io.to(`store:${product.store.id}`).emit('product:reviewed', { productId: id });

    return res.status(201).json(review);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to review product' });
  }
};

export const getProductAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) return res.status(403).json({ error: 'Access denied' });

    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orders, orders7, reviews, cartAdds, wishlistAdds] = await Promise.all([
      prisma.orderItem.aggregate({
        where: { productId: id },
        _sum: { quantity: true, total: true },
        _count: true
      }).catch(() => null),
      prisma.orderItem.aggregate({
        where: { productId: id, createdAt: { gte: since7 } },
        _sum: { quantity: true, total: true },
        _count: true
      }).catch(() => null),
      prisma.productReview.aggregate({
        where: { productId: id, status: 'published' },
        _avg: { rating: true },
        _count: true
      }).catch(() => null),
      prisma.cartItem.count({ where: { productId: id, createdAt: { gte: since30 } } }).catch(() => 0),
      prisma.wishlistItem.count({ where: { productId: id, createdAt: { gte: since30 } } }).catch(() => 0)
    ]);

    const revenue = orders?._sum?.total || 0;
    const sold = orders?._sum?.quantity || 0;
    const conversionRate = product.viewCount > 0 ? (sold / product.viewCount) * 100 : 0;

    return res.json({
      product,
      revenue,
      revenue7Days: orders7?._sum?.total || 0,
      sold,
      sold7Days: orders7?._sum?.quantity || 0,
      orderItems: orders?._count || 0,
      viewCount: product.viewCount || 0,
      salesCount: product.salesCount || sold,
      inventory: product.inventory || 0,
      rating: reviews?._avg?.rating || product.rating || 0,
      reviewsCount: reviews?._count || product.reviewsCount || 0,
      cartAdds30Days: cartAdds || 0,
      wishlistAdds30Days: wishlistAdds || 0,
      conversionRate
    });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to fetch product analytics' });
  }
};

export const bulkUpdateProducts = async (req: Request, res: Response) => {
  try {
    const { storeId, productIds, updates } = req.body;
    const userId = req.userId!;
    const store = await assertStoreOwner(storeId, userId);

    if (!store) return res.status(403).json({ error: 'Store access denied' });

    const ids = safeJson<string[]>(productIds, []);
    const patch = safeJson<Record<string, any>>(updates, {});

    if (!ids.length) return res.status(400).json({ error: 'Product ids required' });

    const allowed: any = {};
    if (patch.status && PRODUCT_STATUSES.has(patch.status)) allowed.status = patch.status;
    if (patch.visibility) allowed.visibility = patch.visibility;
    if (patch.isFeatured !== undefined) allowed.isFeatured = toBoolean(patch.isFeatured, false);
    if (patch.categoryIds !== undefined) allowed.categoryIds = safeJson<string[]>(patch.categoryIds, []);
    if (patch.tags !== undefined) allowed.tags = safeJson<string[]>(patch.tags, []).map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 30);
    if (patch.price !== undefined) allowed.price = Math.max(0, toNumber(patch.price, 0));
    if (patch.inventory !== undefined) allowed.inventory = Math.max(0, Math.floor(toNumber(patch.inventory, 0)));

    const result = await prisma.product.updateMany({
      where: { id: { in: ids }, storeId },
      data: allowed
    });

    io.to(`store:${storeId}`).emit('product:bulk_updated', { storeId, count: result.count });

    return res.json({ status: 'updated', count: result.count });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to bulk update products' });
  }
};
