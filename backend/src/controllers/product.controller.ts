import { Request, Response } from 'express';
import { ProductStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { uploadToCloudinary } from '../utils/media';
import { io } from '../app';

type UploadedFiles = {
  media?: Express.Multer.File[];
};

const MAX_PRODUCT_MEDIA = 12;
const MAX_LIMIT = 50;

const PRODUCT_STATUSES = new Set(Object.values(ProductStatus));

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
    const clean = value.toLowerCase().trim();
    if (clean === 'true') return true;
    if (clean === 'false') return false;
    if (clean === '1') return true;
    if (clean === '0') return false;
  }
  if (typeof value === 'number') return value === 1;
  return fallback;
};

const normalizeStatus = (value: any, fallback: ProductStatus = ProductStatus.DRAFT) => {
  if (typeof value !== 'string') return fallback;
  const upper = value.trim().toUpperCase();
  return PRODUCT_STATUSES.has(upper as ProductStatus) ? (upper as ProductStatus) : fallback;
};

const normalizeVisibility = (value: any, fallback = 'public') => {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim().toLowerCase();
  return ['public', 'private', 'unlisted'].includes(clean) ? clean : fallback;
};

const normalizeStringArray = (value: any, max = 50) => {
  const arr = safeJson<any[]>(value, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, max);
};

const normalizeTags = (value: any) => {
  return [...new Set(normalizeStringArray(value, 30).map((tag) => tag.toLowerCase()))];
};

const getFiles = (req: Request): UploadedFiles => {
  const files = req.files as any;
  if (!files) return {};
  if (Array.isArray(files)) return { media: files };
  return files;
};

const uploadMediaFiles = async (files: Express.Multer.File[] = []) => {
  const selected = files.slice(0, MAX_PRODUCT_MEDIA);
  const uploads = await Promise.all(
    selected.map((file) => uploadToCloudinary(file, 'products', { resource_type: 'auto' }))
  );

  return uploads
    .map((item: any) => item?.secure_url || item?.url || item)
    .filter(Boolean);
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
  if (!storeId) return null;

  return prisma.store.findFirst({
    where: {
      id: storeId,
      ownerId: userId
    },
    select: {
      id: true,
      ownerId: true,
      slug: true,
      name: true,
      isVerified: true
    }
  });
};

const assertProductOwner = async (productId: string, userId: string) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: {
        select: {
          id: true,
          ownerId: true,
          slug: true,
          name: true,
          isVerified: true
        }
      }
    }
  });

  if (!product || product.store.ownerId !== userId) return null;

  return product;
};

const sanitizeProductForPublic = (product: any) => {
  if (!product) return product;

  const {
    internalNotes,
    supplierCost,
    supplierInfo,
    fraudScore,
    costPrice,
    ...safeProduct
  } = product;

  return safeProduct;
};

const safePage = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const safeLimit = (value: any, fallback = 20) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(n));
};

const buildProductWhereForPublic = () => ({
  status: ProductStatus.ACTIVE,
  visibility: 'public'
});

const normalizeMediaList = (value: any) => {
  const arr = Array.isArray(value) ? value : [];
  return arr.map((url) => String(url || '').trim()).filter(Boolean).slice(0, MAX_PRODUCT_MEDIA);
};

const createProductData = (body: any, mediaUrls: string[], uniqueSlug: string, storeId: string) => {
  const productName = cleanText(body.name, 140)!;
  const productPrice = toNumber(body.price, NaN);

  return {
    storeId,
    name: productName,
    slug: uniqueSlug,
    description: cleanText(body.description, 12000) || '',
    shortDescription: cleanText(body.shortDescription, 300) || null,
    price: productPrice,
    compareAtPrice: body.compareAtPrice !== undefined && body.compareAtPrice !== '' ? toNumber(body.compareAtPrice, 0) : null,
    costPrice: body.costPrice !== undefined && body.costPrice !== '' ? toNumber(body.costPrice, 0) : null,
    sku: cleanText(body.sku, 80) || null,
    barcode: cleanText(body.barcode, 80) || null,
    inventory: Math.max(0, Math.floor(toNumber(body.inventory, 0))),
    lowStockThreshold: Math.max(0, Math.floor(toNumber(body.lowStockThreshold, 5))),
    mediaUrls,
    primaryMediaUrl: mediaUrls[0] || '',
    categoryIds: normalizeStringArray(body.categoryIds, 50),
    collectionIds: normalizeStringArray(body.collectionIds, 50),
    tags: normalizeTags(body.tags),
    attributes: safeJson<Record<string, any>>(body.attributes, {}),
    variants: safeJson<any[]>(body.variants, []),
    options: safeJson<any[]>(body.options, []),
    seoTitle: cleanText(body.seoTitle, 70) || productName,
    seoDescription: cleanText(body.seoDescription, 170) || cleanText(body.description, 170) || '',
    isDigital: toBoolean(body.isDigital, false),
    digitalFileUrl: cleanText(body.digitalFileUrl, 1000) || null,
    shippingWeight: Math.max(0, toNumber(body.shippingWeight, 0)),
    shippingDimensions: safeJson<Record<string, any>>(body.shippingDimensions, {}),
    status: normalizeStatus(body.status),
    visibility: normalizeVisibility(body.visibility),
    allowReviews: toBoolean(body.allowReviews, true),
    allowCOD: toBoolean(body.allowCOD, true),
    isFeatured: toBoolean(body.isFeatured, false),
    taxCode: cleanText(body.taxCode, 80) || null,
    metadata: safeJson<Record<string, any>>(body.metadata, {}),
    viewCount: 0,
    salesCount: 0,
    rating: 0,
    reviewsCount: 0
  };
};

export const createProduct = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { storeId, name, slug, price } = req.body;

    const store = await assertStoreOwner(storeId, userId);

    if (!store) {
      return res.status(403).json({
        success: false,
        error: 'Store access denied'
      });
    }

    const productName = cleanText(name, 140);

    if (!productName) {
      return res.status(400).json({
        success: false,
        error: 'Product name required'
      });
    }

    const productPrice = toNumber(price, NaN);

    if (!Number.isFinite(productPrice) || productPrice < 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid product price required'
      });
    }

    const baseSlug = cleanSlug(slug, productName);
    const uniqueSlug = await createUniqueProductSlug(storeId, baseSlug);
    const files = getFiles(req);
    const mediaUrls = await uploadMediaFiles(files.media || []);

    const product = await prisma.product.create({
      data: createProductData(req.body, mediaUrls, uniqueSlug, storeId)
    });

    await prisma.store.update({
      where: { id: storeId },
      data: {
        productsCount: {
          increment: 1
        }
      }
    }).catch(() => null);

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId,
        type: 'PRODUCT_CREATED',
        metadata: {
          productId: product.id,
          name: product.name,
          status: product.status
        }
      }
    }).catch(() => null);

    io.to(`store:${storeId}`).emit('product:new', {
      productId: product.id,
      storeId
    });

    io.to('products').emit('product:created', {
      productId: product.id,
      storeId,
      status: product.status
    });

    return res.status(201).json({
      success: true,
      product
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to create product'
    });
  }
};

export const updateProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const updateData: any = {};
    const files = getFiles(req);

    if (files.media?.length) {
      const newUrls = await uploadMediaFiles(files.media);
      const existingUrls = normalizeMediaList(product.mediaUrls);
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
      if (!cleanedName) {
        return res.status(400).json({
          success: false,
          error: 'Product name cannot be empty'
        });
      }
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
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          success: false,
          error: 'Valid product price required'
        });
      }
      updateData.price = n;
    }

    if (compareAtPrice !== undefined) updateData.compareAtPrice = compareAtPrice === '' ? null : toNumber(compareAtPrice, 0);
    if (costPrice !== undefined) updateData.costPrice = costPrice === '' ? null : toNumber(costPrice, 0);
    if (sku !== undefined) updateData.sku = cleanText(sku, 80) || null;
    if (barcode !== undefined) updateData.barcode = cleanText(barcode, 80) || null;
    if (inventory !== undefined) updateData.inventory = Math.max(0, Math.floor(toNumber(inventory, 0)));
    if (lowStockThreshold !== undefined) updateData.lowStockThreshold = Math.max(0, Math.floor(toNumber(lowStockThreshold, 5)));
    if (categoryIds !== undefined) updateData.categoryIds = normalizeStringArray(categoryIds, 50);
    if (collectionIds !== undefined) updateData.collectionIds = normalizeStringArray(collectionIds, 50);
    if (tags !== undefined) updateData.tags = normalizeTags(tags);
    if (attributes !== undefined) updateData.attributes = safeJson<Record<string, any>>(attributes, {});
    if (variants !== undefined) updateData.variants = safeJson<any[]>(variants, []);
    if (options !== undefined) updateData.options = safeJson<any[]>(options, []);
    if (seoTitle !== undefined) updateData.seoTitle = cleanText(seoTitle, 70) || null;
    if (seoDescription !== undefined) updateData.seoDescription = cleanText(seoDescription, 170) || null;
    if (isDigital !== undefined) updateData.isDigital = toBoolean(isDigital, product.isDigital);
    if (digitalFileUrl !== undefined) updateData.digitalFileUrl = cleanText(digitalFileUrl, 1000) || null;
    if (shippingWeight !== undefined) updateData.shippingWeight = Math.max(0, toNumber(shippingWeight, 0));
    if (shippingDimensions !== undefined) updateData.shippingDimensions = safeJson<Record<string, any>>(shippingDimensions, {});
    if (status !== undefined) updateData.status = normalizeStatus(status, product.status);
    if (visibility !== undefined) updateData.visibility = normalizeVisibility(visibility, product.visibility || 'public');
    if (allowReviews !== undefined) updateData.allowReviews = toBoolean(allowReviews, true);
    if (allowCOD !== undefined) updateData.allowCOD = toBoolean(allowCOD, true);
    if (isFeatured !== undefined) updateData.isFeatured = toBoolean(isFeatured, false);
    if (taxCode !== undefined) updateData.taxCode = cleanText(taxCode, 80) || null;
    if (metadata !== undefined) updateData.metadata = safeJson<Record<string, any>>(metadata, {});

    if (removeMediaUrls !== undefined) {
      const removeList = new Set(normalizeStringArray(removeMediaUrls, MAX_PRODUCT_MEDIA));
      const current = Array.isArray(updateData.mediaUrls) ? updateData.mediaUrls : normalizeMediaList(product.mediaUrls);
      updateData.mediaUrls = current.filter((url: string) => !removeList.has(url));
      if (removeList.has(product.primaryMediaUrl)) updateData.primaryMediaUrl = updateData.mediaUrls[0] || '';
    }

    if (primaryMediaUrl !== undefined) {
      const cleanPrimary = String(primaryMediaUrl || '').trim();
      const mediaList = Array.isArray(updateData.mediaUrls) ? updateData.mediaUrls : normalizeMediaList(product.mediaUrls);
      if (mediaList.includes(cleanPrimary)) updateData.primaryMediaUrl = cleanPrimary;
    }

    const updated = await prisma.product.update({
      where: { id },
      data: updateData
    });

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId: product.storeId,
        type: 'PRODUCT_UPDATED',
        metadata: {
          productId: id,
          changedFields: Object.keys(updateData)
        }
      }
    }).catch(() => null);

    io.to(`store:${product.storeId}`).emit('product:updated', {
      productId: id,
      storeId: product.storeId
    });

    io.to(`product:${id}`).emit('product:updated', {
      productId: id
    });

    return res.json({
      success: true,
      product: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to update product'
    });
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
              select: {
                id: true,
                username: true,
                fullName: true,
                avatarUrl: true,
                isVerified: true
              }
            }
          }
        },
        _count: {
          select: {
            reviews: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    const isOwner = Boolean(viewerId && product.store.ownerId === viewerId);

    if (!isOwner && (product.status !== ProductStatus.ACTIVE || product.visibility !== 'public')) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    if (!isOwner) {
      await prisma.product.update({
        where: { id },
        data: {
          viewCount: {
            increment: 1
          }
        }
      }).catch(() => null);

      await prisma.commerceEvent.create({
        data: {
          userId: viewerId || null,
          storeId: product.storeId,
          type: 'PRODUCT_VIEWED',
          metadata: {
            productId: id
          }
        }
      }).catch(() => null);
    }

    io.to(`product:${id}`).emit('product:viewed', {
      productId: id
    });

    return res.json({
      success: true,
      product: sanitizeProductForPublic(product)
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch product'
    });
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
    const pageNum = safePage(page);
    const take = safeLimit(limit);

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        ownerId: true
      }
    });

    if (!store) {
      return res.status(404).json({
        success: false,
        error: 'Store not found'
      });
    }

    const isOwner = Boolean(userId && store.ownerId === userId);

    const where: any = {
      storeId,
      ...(isOwner && includeDrafts === 'true'
        ? { status: { not: ProductStatus.DISABLED } }
        : buildProductWhereForPublic())
    };

    if (category) where.categoryIds = { has: String(category) };
    if (collection) where.collectionIds = { has: String(collection) };

    if (q) {
      const query = String(q).trim();
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { tags: { has: query.toLowerCase() } },
        { sku: { contains: query, mode: 'insensitive' } }
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
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              isVerified: true,
              trustScore: true
            }
          },
          _count: {
            select: {
              reviews: true
            }
          }
        }
      }),
      prisma.product.count({ where })
    ]);

    return res.json({
      success: true,
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
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch products'
    });
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

    const take = safeLimit(limit);

    const where: any = buildProductWhereForPublic();

    if (storeId) where.storeId = String(storeId);
    if (category) where.categoryIds = { has: String(category) };
    if (collection) where.collectionIds = { has: String(collection) };
    if (tag) where.tags = { has: String(tag).toLowerCase() };

    if (q) {
      const query = String(q).trim();
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { tags: { has: query.toLowerCase() } },
        { sku: { contains: query, mode: 'insensitive' } }
      ];
    }

    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = toNumber(minPrice, 0);
      if (maxPrice) where.price.lte = toNumber(maxPrice, Number.MAX_SAFE_INTEGER);
    }

    if (inStock === 'true') where.inventory = { gt: 0 };
    if (featured === 'true') where.isFeatured = true;
    if (verifiedStore === 'true') where.store = { isVerified: true };

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
          select: {
            reviews: true
          }
        }
      }
    });

    const hasMore = products.length > take;
    const items = hasMore ? products.slice(0, take) : products;

    return res.json({
      success: true,
      products: items.map(sanitizeProductForPublic),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      hasMore
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to search products'
    });
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const wasCountable = product.status !== ProductStatus.DISABLED;

    const updated = await prisma.product.update({
      where: { id },
      data: {
        status: ProductStatus.DISABLED,
        visibility: 'private'
      }
    });

    if (wasCountable) {
      await prisma.store.update({
        where: { id: product.storeId },
        data: {
          productsCount: {
            decrement: 1
          }
        }
      }).catch(() => null);
    }

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId: product.storeId,
        type: 'PRODUCT_DISABLED',
        metadata: {
          productId: id
        }
      }
    }).catch(() => null);

    io.to(`store:${product.storeId}`).emit('product:disabled', {
      productId: id,
      storeId: product.storeId
    });

    io.to(`product:${id}`).emit('product:disabled', {
      productId: id
    });

    return res.json({
      success: true,
      status: 'deleted',
      product: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to delete product'
    });
  }
};

export const restoreProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const wasDisabled = product.status === ProductStatus.DISABLED;

    const restored = await prisma.product.update({
      where: { id },
      data: {
        status: ProductStatus.DRAFT,
        visibility: 'private'
      }
    });

    if (wasDisabled) {
      await prisma.store.update({
        where: { id: product.storeId },
        data: {
          productsCount: {
            increment: 1
          }
        }
      }).catch(() => null);
    }

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId: product.storeId,
        type: 'PRODUCT_RESTORED',
        metadata: {
          productId: id
        }
      }
    }).catch(() => null);

    io.to(`store:${product.storeId}`).emit('product:restored', {
      productId: id,
      storeId: product.storeId
    });

    return res.json({
      success: true,
      product: restored
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to restore product'
    });
  }
};

export const setProductPrimaryMedia = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { mediaUrl } = req.body;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const cleanMediaUrl = String(mediaUrl || '').trim();
    const mediaUrls = normalizeMediaList(product.mediaUrls);

    if (!mediaUrls.includes(cleanMediaUrl)) {
      return res.status(400).json({
        success: false,
        error: 'Media not found in product'
      });
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        primaryMediaUrl: cleanMediaUrl
      }
    });

    io.to(`store:${product.storeId}`).emit('product:updated', {
      productId: id,
      storeId: product.storeId
    });

    return res.json({
      success: true,
      product: updated
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to set primary media'
    });
  }
};

export const reviewProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { rating, title, content, mediaUrls } = req.body;
    const userId = req.userId!;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        store: {
          select: {
            ownerId: true,
            id: true
          }
        }
      }
    });

    if (!product || product.status !== ProductStatus.ACTIVE || product.visibility !== 'public') {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    if (product.store.ownerId === userId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot review own product'
      });
    }

    if (product.allowReviews === false) {
      return res.status(400).json({
        success: false,
        error: 'Reviews disabled for this product'
      });
    }

    const cleanRating = Math.min(5, Math.max(1, Math.floor(toNumber(rating, 5))));

    const review = await prisma.productReview.upsert({
      where: {
        productId_buyerId: {
          productId: id,
          buyerId: userId
        }
      },
      update: {
        rating: cleanRating,
        title: cleanText(title, 120) || null,
        content: cleanText(content, 3000) || '',
        mediaUrls: normalizeStringArray(mediaUrls, 10),
        status: 'published'
      },
      create: {
        productId: id,
        buyerId: userId,
        rating: cleanRating,
        title: cleanText(title, 120) || null,
        content: cleanText(content, 3000) || '',
        mediaUrls: normalizeStringArray(mediaUrls, 10),
        status: 'published'
      }
    });

    const aggregate = await prisma.productReview.aggregate({
      where: {
        productId: id,
        status: 'published'
      },
      _avg: {
        rating: true
      },
      _count: true
    });

    await prisma.product.update({
      where: { id },
      data: {
        rating: aggregate._avg.rating || 0,
        reviewsCount: aggregate._count || 0
      }
    });

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId: product.store.id,
        type: 'PRODUCT_REVIEWED',
        metadata: {
          productId: id,
          rating: cleanRating,
          reviewId: review.id
        }
      }
    }).catch(() => null);

    io.to(`product:${id}`).emit('product:reviewed', {
      productId: id,
      rating: aggregate._avg.rating || 0
    });

    io.to(`store:${product.store.id}`).emit('product:reviewed', {
      productId: id
    });

    return res.status(201).json({
      success: true,
      review
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to review product'
    });
  }
};

export const getProductAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const product = await assertProductOwner(id, userId);

    if (!product) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orders, orders7, reviews, cartAdds, wishlistAdds] = await Promise.all([
      prisma.orderItem.aggregate({
        where: {
          productId: id
        },
        _sum: {
          quantity: true
        },
        _count: true
      }).catch(() => null),
      prisma.orderItem.aggregate({
        where: {
          productId: id,
          createdAt: {
            gte: since7
          }
        },
        _sum: {
          quantity: true
        },
        _count: true
      }).catch(() => null),
      prisma.productReview.aggregate({
        where: {
          productId: id,
          status: 'published'
        },
        _avg: {
          rating: true
        },
        _count: true
      }).catch(() => null),
      prisma.cartItem.count({
        where: {
          productId: id,
          createdAt: {
            gte: since30
          }
        }
      }).catch(() => 0),
      prisma.wishlistItem.count({
        where: {
          productId: id,
          createdAt: {
            gte: since30
          }
        }
      }).catch(() => 0)
    ]);

    const sold = orders?._sum?.quantity || 0;
    const sold7Days = orders7?._sum?.quantity || 0;
    const revenue = Number(product.price || 0) * Number(sold || 0);
    const revenue7Days = Number(product.price || 0) * Number(sold7Days || 0);
    const conversionRate = Number(product.viewCount || 0) > 0 ? (Number(sold || 0) / Number(product.viewCount || 0)) * 100 : 0;

    return res.json({
      success: true,
      analytics: {
        product: sanitizeProductForPublic(product),
        revenue,
        revenue7Days,
        sold,
        sold7Days,
        orderItems: orders?._count || 0,
        viewCount: product.viewCount || 0,
        salesCount: product.salesCount || sold,
        inventory: product.inventory || 0,
        rating: reviews?._avg?.rating || product.rating || 0,
        reviewsCount: reviews?._count || product.reviewsCount || 0,
        cartAdds30Days: cartAdds || 0,
        wishlistAdds30Days: wishlistAdds || 0,
        conversionRate
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to fetch product analytics'
    });
  }
};

export const bulkUpdateProducts = async (req: Request, res: Response) => {
  try {
    const { storeId, productIds, updates } = req.body;
    const userId = req.userId!;
    const store = await assertStoreOwner(storeId, userId);

    if (!store) {
      return res.status(403).json({
        success: false,
        error: 'Store access denied'
      });
    }

    const ids = normalizeStringArray(productIds, 200);
    const patch = safeJson<Record<string, any>>(updates, {});

    if (!ids.length) {
      return res.status(400).json({
        success: false,
        error: 'Product ids required'
      });
    }

    const allowed: any = {};

    if (patch.status !== undefined) allowed.status = normalizeStatus(patch.status);
    if (patch.visibility !== undefined) allowed.visibility = normalizeVisibility(patch.visibility);
    if (patch.isFeatured !== undefined) allowed.isFeatured = toBoolean(patch.isFeatured, false);
    if (patch.categoryIds !== undefined) allowed.categoryIds = normalizeStringArray(patch.categoryIds, 50);
    if (patch.collectionIds !== undefined) allowed.collectionIds = normalizeStringArray(patch.collectionIds, 50);
    if (patch.tags !== undefined) allowed.tags = normalizeTags(patch.tags);
    if (patch.price !== undefined) allowed.price = Math.max(0, toNumber(patch.price, 0));
    if (patch.inventory !== undefined) allowed.inventory = Math.max(0, Math.floor(toNumber(patch.inventory, 0)));
    if (patch.allowCOD !== undefined) allowed.allowCOD = toBoolean(patch.allowCOD, true);
    if (patch.allowReviews !== undefined) allowed.allowReviews = toBoolean(patch.allowReviews, true);

    if (!Object.keys(allowed).length) {
      return res.status(400).json({
        success: false,
        error: 'No valid update fields provided'
      });
    }

    const result = await prisma.product.updateMany({
      where: {
        id: {
          in: ids
        },
        storeId
      },
      data: allowed
    });

    await prisma.commerceEvent.create({
      data: {
        userId,
        storeId,
        type: 'PRODUCT_BULK_UPDATED',
        metadata: {
          count: result.count,
          fields: Object.keys(allowed)
        }
      }
    }).catch(() => null);

    io.to(`store:${storeId}`).emit('product:bulk_updated', {
      storeId,
      count: result.count
    });

    return res.json({
      success: true,
      status: 'updated',
      count: result.count
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || 'Failed to bulk update products'
    });
  }
};
