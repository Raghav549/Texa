import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db";
import { uploadToCloudinary } from "../utils/media";
import { calculateTrustScore } from "../services/trustAlgorithm";
import { io } from "../app";

type StoreFileMap = {
  logo?: Express.Multer.File[];
  banner?: Express.Multer.File[];
  gallery?: Express.Multer.File[];
};

const STORE_STATUS_ACTIVE = "active";
const STORE_STATUS_DISABLED = "disabled";
const STORE_DEFAULT_LIMIT = 20;
const STORE_MAX_LIMIT = 50;
const STORE_MAX_GALLERY = 12;
const STORE_SLUG_MIN = 3;
const STORE_SLUG_MAX = 64;

const ok = (res: Response, data: any, status = 200) => res.status(status).json(data);

const fail = (res: Response, status: number, error: string, extra: Record<string, any> = {}) =>
  res.status(status).json({ error, ...extra });

const safeJson = <T = any>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

const cleanText = (value: unknown, max = 500) => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  return cleaned.slice(0, max);
};

const cleanRequiredText = (value: unknown, max = 500) => {
  const text = cleanText(value, max);
  return text || "";
};

const parseBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
};

const parseNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const lower = typeof min === "number" ? Math.max(n, min) : n;
  return typeof max === "number" ? Math.min(lower, max) : lower;
};

const parseLimit = (value: unknown) => Math.floor(parseNumber(value, STORE_DEFAULT_LIMIT, 1, STORE_MAX_LIMIT));

const normalizeArray = (value: unknown, maxItems: number, maxText: number) => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().startsWith("[")
      ? safeJson<any[]>(value, [])
      : typeof value === "string"
        ? value.split(/[,\n]/)
        : [];

  return Array.from(
    new Set(
      raw
        .map(item => cleanText(String(item), maxText))
        .filter((item): item is string => Boolean(item))
    )
  ).slice(0, maxItems);
};

const normalizeTags = (value: unknown) =>
  normalizeArray(value, 20, 40).map(tag =>
    tag
      .replace(/^#/, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]/gu, "")
  ).filter(Boolean);

const normalizeSlug = (value: unknown, fallback?: unknown) => {
  const base = cleanText(value, STORE_SLUG_MAX) || cleanText(fallback, STORE_SLUG_MAX) || `store-${Date.now()}`;
  const slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, STORE_SLUG_MAX);

  if (slug.length >= STORE_SLUG_MIN) return slug;

  return `store-${slug || Date.now()}`.slice(0, STORE_SLUG_MAX);
};

const uniqueSlug = async (baseSlug: string, storeId?: string) => {
  let slug = baseSlug;
  let count = 1;

  while (true) {
    const existing = await prisma.store.findUnique({
      where: { slug },
      select: { id: true }
    });

    if (!existing || existing.id === storeId) return slug;

    count += 1;
    const suffix = `-${count}`;
    slug = `${baseSlug.slice(0, STORE_SLUG_MAX - suffix.length)}${suffix}`;
  }
};

const pickSort = (sort: unknown): Prisma.StoreOrderByWithRelationInput | Prisma.StoreOrderByWithRelationInput[] => {
  const key = String(sort || "").toLowerCase();

  if (key === "trust") return [{ trustScore: "desc" }, { rating: "desc" }, { updatedAt: "desc" }];
  if (key === "newest") return { createdAt: "desc" };
  if (key === "products") return [{ productsCount: "desc" }, { rating: "desc" }];
  if (key === "orders") return [{ ordersCount: "desc" }, { rating: "desc" }];
  if (key === "reviews") return [{ reviewsCount: "desc" }, { rating: "desc" }];

  return [{ rating: "desc" }, { trustScore: "desc" }, { updatedAt: "desc" }];
};

const getFiles = (req: Request) => (req.files || {}) as StoreFileMap;

const uploadFile = async (file: Express.Multer.File, folder: string) => {
  const result = await uploadToCloudinary(file, folder, {
    resource_type: "auto",
    transformation: [{ quality: "auto:good", fetch_format: "auto" }]
  });

  return typeof result === "string" ? result : result?.secure_url || result?.url || "";
};

const buildStorePayload = (body: any, slug?: string) => {
  const payload: any = {};
  const name = cleanText(body.name, 120);
  const description = cleanText(body.description, 2000);
  const category = cleanText(body.category, 80);
  const currency = cleanText(body.currency, 10);
  const language = cleanText(body.language, 10);
  const timezone = cleanText(body.timezone, 80);
  const status = cleanText(body.status, 30);
  const address = safeJson(body.address, body.address || null);
  const contact = safeJson(body.contact, body.contact || null);
  const socialLinks = safeJson(body.socialLinks, body.socialLinks || {});
  const settings = safeJson(body.settings, body.settings || {});
  const theme = safeJson(body.theme, body.theme || {});
  const businessHours = safeJson(body.businessHours, body.businessHours || {});
  const policies = safeJson(body.policies, body.policies || {});
  const metadata = safeJson(body.metadata, body.metadata || {});
  const tags = normalizeTags(body.tags);
  const serviceAreas = normalizeArray(body.serviceAreas, 30, 80);
  const features = normalizeArray(body.features, 30, 60);

  if (name) payload.name = name;
  if (slug) payload.slug = slug;
  if (description !== undefined) payload.description = description;
  if (category !== undefined) payload.category = category;
  if (currency !== undefined) payload.currency = currency;
  if (language !== undefined) payload.language = language;
  if (timezone !== undefined) payload.timezone = timezone;
  if (status !== undefined) payload.status = status;
  if (address !== undefined) payload.address = address;
  if (contact !== undefined) payload.contact = contact;
  if (socialLinks !== undefined) payload.socialLinks = socialLinks;
  if (settings !== undefined) payload.settings = settings;
  if (theme !== undefined) payload.theme = theme;
  if (businessHours !== undefined) payload.businessHours = businessHours;
  if (policies !== undefined) payload.policies = policies;
  if (metadata !== undefined) payload.metadata = metadata;
  if (tags.length) payload.tags = tags;
  if (serviceAreas.length) payload.serviceAreas = serviceAreas;
  if (features.length) payload.features = features;

  return payload;
};

const assertStoreOwner = async (storeId: string, userId: string) => {
  return prisma.store.findFirst({
    where: {
      id: storeId,
      ownerId: userId,
      status: { not: STORE_STATUS_DISABLED }
    }
  });
};

const publicStoreInclude = {
  owner: {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true
    }
  },
  products: {
    where: { status: "active" },
    take: 12,
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      salePrice: true,
      images: true,
      rating: true,
      salesCount: true,
      viewCount: true
    }
  },
  reviews: {
    take: 5,
    orderBy: { createdAt: "desc" as const },
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
      products: true,
      orders: true,
      reviews: true
    }
  }
};

const refreshStoreStats = async (storeId: string) => {
  const [products, orders, reviews] = await Promise.all([
    prisma.product.aggregate({
      where: { storeId },
      _count: true
    }),
    prisma.order.aggregate({
      where: { storeId },
      _count: true
    }),
    prisma.storeReview.aggregate({
      where: { storeId },
      _avg: { rating: true },
      _count: true
    })
  ]);

  const updated = await prisma.store.update({
    where: { id: storeId },
    data: {
      productsCount: products._count || 0,
      ordersCount: orders._count || 0,
      reviewsCount: reviews._count || 0,
      rating: Number((reviews._avg.rating || 0).toFixed(2))
    }
  });

  await calculateTrustScore(storeId).catch(() => null);

  return updated;
};

const emitStoreUpdate = (storeId: string, event: string, payload: any) => {
  io.to("stores").emit(event, payload);
  io.to(`store:${storeId}`).emit(event, payload);
};

export const createStore = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const name = cleanRequiredText(req.body.name, 120);

    if (!name) return fail(res, 400, "Store name is required");

    const baseSlug = normalizeSlug(req.body.slug, name);
    const slug = await uniqueSlug(baseSlug);
    const isBusiness = parseBool(req.body.isBusiness, false);
    const files = getFiles(req);
    const payload = buildStorePayload({ ...req.body, name }, slug);

    const [logoUrl, bannerUrl] = await Promise.all([
      files.logo?.[0] ? uploadFile(files.logo[0], "stores/logos") : Promise.resolve(undefined),
      files.banner?.[0] ? uploadFile(files.banner[0], "stores/banners") : Promise.resolve(undefined)
    ]);

    const galleryFiles = files.gallery?.slice(0, STORE_MAX_GALLERY) || [];
    const galleryUrls = await Promise.all(galleryFiles.map(file => uploadFile(file, "stores/gallery")));

    const store = await prisma.$transaction(async tx => {
      const created = await tx.store.create({
        data: {
          ownerId: userId,
          ...payload,
          logoUrl,
          bannerUrl,
          galleryUrls: galleryUrls.filter(Boolean),
          isVerified: isBusiness,
          status: STORE_STATUS_ACTIVE,
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
          update: {
            businessName: name,
            storeId: created.id,
            verificationStatus: "VERIFIED"
          },
          create: {
            userId,
            businessName: name,
            storeId: created.id,
            verificationStatus: "VERIFIED"
          }
        }).catch(async () => {
          await tx.businessProfile.upsert({
            where: { userId },
            update: {
              businessName: name,
              storeId: created.id,
              verificationStatus: "verified"
            },
            create: {
              userId,
              businessName: name,
              storeId: created.id,
              verificationStatus: "verified"
            }
          });
        });
      }

      return created;
    });

    await calculateTrustScore(store.id).catch(() => null);

    emitStoreUpdate(store.id, "store:created", {
      storeId: store.id,
      slug: store.slug,
      ownerId: userId
    });

    io.to(`user:${userId}`).emit("store:created", store);

    return ok(res, store, 201);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to create store");
  }
};

export const updateStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await assertStoreOwner(id, userId);

    if (!store) return fail(res, 403, "Access denied");

    const files = getFiles(req);
    const updateData: any = buildStorePayload(req.body);

    if (req.body.slug) {
      updateData.slug = await uniqueSlug(normalizeSlug(req.body.slug, updateData.name || store.name), id);
    }

    if (files.logo?.[0]) updateData.logoUrl = await uploadFile(files.logo[0], "stores/logos");
    if (files.banner?.[0]) updateData.bannerUrl = await uploadFile(files.banner[0], "stores/banners");

    if (files.gallery?.length) {
      const galleryUrls = await Promise.all(files.gallery.slice(0, STORE_MAX_GALLERY).map(file => uploadFile(file, "stores/gallery")));
      const existing = Array.isArray((store as any).galleryUrls) ? (store as any).galleryUrls : [];
      updateData.galleryUrls = [...existing, ...galleryUrls.filter(Boolean)].slice(0, STORE_MAX_GALLERY);
    }

    if (req.body.removeGalleryUrls !== undefined) {
      const removeList = normalizeArray(req.body.removeGalleryUrls, STORE_MAX_GALLERY, 500);
      const existing = Array.isArray((store as any).galleryUrls) ? (store as any).galleryUrls : [];
      updateData.galleryUrls = existing.filter((url: string) => !removeList.includes(url));
    }

    if (!Object.keys(updateData).length) return fail(res, 400, "No valid update fields provided");

    const updated = await prisma.store.update({
      where: { id },
      data: updateData,
      include: {
        _count: {
          select: {
            products: true,
            orders: true,
            reviews: true
          }
        }
      }
    });

    await calculateTrustScore(id).catch(() => null);

    emitStoreUpdate(id, "store:updated", updated);
    io.to(`user:${userId}`).emit("store:updated", updated);

    return ok(res, updated);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to update store");
  }
};

export const getStore = async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const viewerId = req.userId;

    const store = await prisma.store.findUnique({
      where: { slug },
      include: publicStoreInclude
    });

    if (!store || store.status === STORE_STATUS_DISABLED) return fail(res, 404, "Store not found");

    const isOwner = viewerId === store.ownerId;

    const sanitized = {
      ...store,
      privateNotes: isOwner ? (store as any).privateNotes : undefined,
      payoutSettings: isOwner ? (store as any).payoutSettings : undefined,
      internalFlags: undefined,
      isOwner,
      isFollowing: viewerId ? Array.isArray((store as any).followers) && (store as any).followers.includes(viewerId) : false,
      followerCount: Array.isArray((store as any).followers) ? (store as any).followers.length : 0
    };

    return ok(res, sanitized);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to fetch store");
  }
};

export const getStoreById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const viewerId = req.userId;

    const store = await prisma.store.findUnique({
      where: { id },
      include: publicStoreInclude
    });

    if (!store || store.status === STORE_STATUS_DISABLED) return fail(res, 404, "Store not found");

    const isOwner = viewerId === store.ownerId;

    return ok(res, {
      ...store,
      privateNotes: isOwner ? (store as any).privateNotes : undefined,
      payoutSettings: isOwner ? (store as any).payoutSettings : undefined,
      internalFlags: undefined,
      isOwner,
      isFollowing: viewerId ? Array.isArray((store as any).followers) && (store as any).followers.includes(viewerId) : false,
      followerCount: Array.isArray((store as any).followers) ? (store as any).followers.length : 0
    });
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to fetch store");
  }
};

export const searchStores = async (req: Request, res: Response) => {
  try {
    const { q, category, minTrust, sort = "rating", cursor, verifiedOnly = "true" } = req.query;
    const limit = parseLimit(req.query.limit);
    const query = cleanText(q, 100);

    const where: Prisma.StoreWhereInput = {
      status: { not: STORE_STATUS_DISABLED },
      isVerified: parseBool(verifiedOnly, true) ? true : undefined
    };

    if (query) {
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { tags: { has: query.toLowerCase() } },
        { category: { contains: query, mode: "insensitive" } }
      ];
    }

    if (category) where.category = { equals: String(category), mode: "insensitive" };
    if (minTrust) where.trustScore = { gte: parseNumber(minTrust, 0, 0, 100) };

    const stores = await prisma.store.findMany({
      where,
      orderBy: pickSort(sort),
      cursor: cursor ? { id: String(cursor) } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1,
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatarUrl: true,
            isVerified: true
          }
        },
        _count: {
          select: {
            products: true,
            reviews: true
          }
        }
      }
    });

    const hasMore = stores.length > limit;
    const result = hasMore ? stores.slice(0, -1) : stores;

    return ok(res, {
      stores: result.map(store => ({
        ...store,
        followerCount: Array.isArray((store as any).followers) ? (store as any).followers.length : 0
      })),
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to search stores");
  }
};

export const getMyStores = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const stores = await prisma.store.findMany({
      where: {
        ownerId: userId,
        status: { not: STORE_STATUS_DISABLED }
      },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: {
          select: {
            products: true,
            orders: true,
            reviews: true
          }
        }
      }
    });

    return ok(res, stores);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to fetch stores");
  }
};

export const followStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const remove = parseBool(req.body.remove, false);
    const userId = req.userId!;

    const store = await prisma.store.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        followers: true,
        status: true,
        name: true
      }
    });

    if (!store || store.status === STORE_STATUS_DISABLED) return fail(res, 404, "Store not found");
    if (store.ownerId === userId && !remove) return fail(res, 400, "You cannot follow your own store");

    const followers = Array.isArray((store as any).followers) ? (store as any).followers : [];
    const nextFollowers = remove ? followers.filter((uid: string) => uid !== userId) : Array.from(new Set([...followers, userId]));

    const updated = await prisma.store.update({
      where: { id },
      data: { followers: nextFollowers },
      select: {
        id: true,
        followers: true
      }
    });

    if (!remove && store.ownerId !== userId) {
      await prisma.notification.create({
        data: {
          userId: store.ownerId,
          type: "STORE",
          title: "New store follower",
          body: "Someone followed your store",
          data: {
            storeId: id,
            from: userId
          },
          read: false
        }
      }).catch(() => null);

      io.to(`user:${store.ownerId}`).emit("notification:store_follow", {
        storeId: id,
        from: userId,
        timestamp: new Date()
      });
    }

    emitStoreUpdate(id, "store:followers", {
      storeId: id,
      count: updated.followers.length,
      followedBy: userId,
      removed: remove
    });

    return ok(res, {
      status: remove ? "unfollowed" : "followed",
      count: updated.followers.length
    });
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to update follow status");
  }
};

export const reviewStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const rating = parseNumber(req.body.rating, 0, 1, 5);
    const comment = cleanText(req.body.comment, 1000) || "";

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return fail(res, 400, "Valid rating is required");

    const store = await prisma.store.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        status: true
      }
    });

    if (!store || store.status === STORE_STATUS_DISABLED) return fail(res, 404, "Store not found");
    if (store.ownerId === userId) return fail(res, 400, "You cannot review your own store");

    const review = await prisma.storeReview.upsert({
      where: {
        storeId_buyerId: {
          storeId: id,
          buyerId: userId
        }
      },
      update: {
        rating,
        comment
      },
      create: {
        storeId: id,
        buyerId: userId,
        rating,
        comment
      },
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
    });

    await refreshStoreStats(id);

    emitStoreUpdate(id, "store:reviewed", review);

    await prisma.notification.create({
      data: {
        userId: store.ownerId,
        type: "STORE",
        title: "New store review",
        body: `Your store received a ${rating} star review`,
        data: {
          storeId: id,
          from: userId,
          rating
        },
        read: false
      }
    }).catch(() => null);

    io.to(`user:${store.ownerId}`).emit("notification:store_review", {
      storeId: id,
      from: userId,
      rating,
      timestamp: new Date()
    });

    return ok(res, review, 201);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to review store");
  }
};

export const deleteStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await assertStoreOwner(id, userId);

    if (!store) return fail(res, 403, "Access denied");

    await prisma.store.update({
      where: { id },
      data: {
        status: STORE_STATUS_DISABLED,
        disabledAt: new Date()
      }
    });

    emitStoreUpdate(id, "store:disabled", { storeId: id });

    return ok(res, { status: "disabled" });
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to disable store");
  }
};

export const restoreStore = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const store = await prisma.store.findFirst({
      where: {
        id,
        ownerId: userId,
        status: STORE_STATUS_DISABLED
      }
    });

    if (!store) return fail(res, 403, "Access denied");

    const updated = await prisma.store.update({
      where: { id },
      data: {
        status: STORE_STATUS_ACTIVE,
        disabledAt: null
      }
    });

    emitStoreUpdate(id, "store:restored", updated);

    return ok(res, updated);
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to restore store");
  }
};

export const getStoreAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const store = await prisma.store.findFirst({
      where: {
        id,
        ownerId: userId
      }
    });

    if (!store) return fail(res, 403, "Access denied");

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
      dailyRevenue
    ] = await Promise.all([
      prisma.order.aggregate({
        where: { storeId: id },
        _sum: { total: true },
        _count: true
      }),
      prisma.order.aggregate({
        where: {
          storeId: id,
          createdAt: { gte: start7 }
        },
        _sum: { total: true },
        _count: true
      }),
      prisma.product.aggregate({
        where: { storeId: id },
        _sum: {
          salesCount: true,
          viewCount: true
        },
        _count: true
      }),
      prisma.storeReview.aggregate({
        where: { storeId: id },
        _avg: { rating: true },
        _count: true
      }),
      prisma.advertisement.aggregate({
        where: { storeId: id },
        _sum: {
          impressions: true,
          clicks: true,
          conversions: true,
          spend: true
        }
      }).catch(() => ({
        _sum: {
          impressions: 0,
          clicks: 0,
          conversions: 0,
          spend: 0
        }
      })),
      prisma.product.findMany({
        where: { storeId: id },
        orderBy: { salesCount: "desc" },
        take: 5,
        select: {
          id: true,
          name: true,
          slug: true,
          images: true,
          salesCount: true,
          viewCount: true,
          price: true,
          salePrice: true
        }
      }),
      prisma.order.findMany({
        where: { storeId: id },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          total: true,
          status: true,
          paymentStatus: true,
          createdAt: true
        }
      }),
      prisma.$queryRaw`
        SELECT DATE("createdAt") as date, COALESCE(SUM(total), 0) as revenue, COUNT(*) as orders
        FROM "Order"
        WHERE "storeId" = ${id}
        AND "createdAt" >= ${start30}
        GROUP BY DATE("createdAt")
        ORDER BY date ASC
      `.catch(() => [])
    ]);

    const impressions = Number((adPerformance as any)._sum?.impressions || 0);
    const clicks = Number((adPerformance as any)._sum?.clicks || 0);
    const conversions = Number((adPerformance as any)._sum?.conversions || 0);
    const spend = Number((adPerformance as any)._sum?.spend || 0);
    const revenue = Number(orders._sum.total || 0);
    const revenue7 = Number(orders7._sum.total || 0);
    const productSales = Number(products._sum.salesCount || 0);
    const productViews = Number(products._sum.viewCount || 0);
    const followerCount = Array.isArray((store as any).followers) ? (store as any).followers.length : 0;

    return ok(res, {
      store,
      revenue,
      revenue7,
      orderCount: orders._count || 0,
      orderCount7: orders7._count || 0,
      productSales,
      productViews,
      productCount: products._count || 0,
      avgRating: Number((reviews._avg.rating || 0).toFixed(2)),
      reviewsCount: reviews._count || 0,
      followerCount,
      conversionRate: productViews ? Number(((productSales / productViews) * 100).toFixed(2)) : 0,
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
    return fail(res, 500, err?.message || "Failed to fetch store analytics");
  }
};

export const refreshStoreTrust = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const store = await assertStoreOwner(id, userId);

    if (!store) return fail(res, 403, "Access denied");

    const result = await calculateTrustScore(id).catch(() => null);
    const updated = await refreshStoreStats(id);

    emitStoreUpdate(id, "store:trust_updated", {
      storeId: id,
      trustScore: updated.trustScore
    });

    return ok(res, {
      status: "updated",
      trust: result,
      store: updated
    });
  } catch (err: any) {
    return fail(res, 500, err?.message || "Failed to refresh store trust");
  }
};
