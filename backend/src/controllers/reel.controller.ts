import { Request, Response } from "express";
import { NotificationType, TransactionStatus, TransactionType, WalletSource } from "@prisma/client";
import { prisma } from "../config/db";
import { uploadToCloudinary, generateVideoThumbnails, transcodeVideo } from "../utils/media";
import { io } from "../app";
import { calculateTrendingScore, generateFeedRanking } from "../services/feedAlgorithm";
import { moderateContent } from "../services/contentModeration";
import { extractHashtags, extractMentions } from "../utils/messageParser";

type Visibility = "public" | "followers" | "private";

type NormalizedModeration = {
  status: "SAFE" | "REVIEW" | "BLOCKED";
  flagged: boolean;
  reason: string | null;
  ageRestricted: boolean;
};

const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const success = (res: Response, data: any, status = 200) => res.status(status).json({ success: true, ok: true, ...data });

const failure = (res: Response, status: number, error: string, extra: Record<string, any> = {}) =>
  res.status(status).json({ success: false, ok: false, error, ...extra });

const toBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
};

const toNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const lower = typeof min === "number" ? Math.max(n, min) : n;
  return typeof max === "number" ? Math.min(lower, max) : lower;
};

const parseJson = <T = any>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const cleanText = (value: unknown, max = 2200) => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};

const normalizeTag = (tag: string) => tag.replace(/^#/, "").trim().toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, "");

const normalizeUsername = (value: string) => value.replace(/^@/, "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");

const normalizeHashtags = (caption: string, input?: unknown) => {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string" && input.trim().startsWith("[")
      ? parseJson<string[]>(input, [])
      : typeof input === "string"
        ? input.split(/[,\s]+/)
        : [];

  const extracted = extractHashtags(caption);

  return Array.from(new Set([...raw.map(String), ...extracted].map(normalizeTag).filter(Boolean))).slice(0, 30);
};

const normalizeMentions = (caption: string, input?: unknown) => {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string" && input.trim().startsWith("[")
      ? parseJson<string[]>(input, [])
      : typeof input === "string"
        ? input.split(/[,\s]+/)
        : [];

  const extracted = extractMentions(caption);

  return Array.from(new Set([...raw.map(String), ...extracted].map(normalizeUsername).filter(Boolean))).slice(0, 50);
};

const getSafeLimit = (limit: unknown, fallback = DEFAULT_LIMIT) => Math.floor(toNumber(limit, fallback, 1, MAX_LIMIT));

const normalizeModeration = (value: any): NormalizedModeration => {
  const rawStatus = String(value?.status || "").toUpperCase();
  const flagged = Boolean(value?.flagged);
  const reason = value?.reason ? String(value.reason) : null;
  const ageRestricted = Boolean(value?.ageRestricted);

  if (rawStatus === "BLOCKED" || rawStatus === "REJECTED") {
    return { status: "BLOCKED", flagged: true, reason: reason || "blocked_content", ageRestricted };
  }

  if (rawStatus === "REVIEW" || rawStatus === "PENDING" || rawStatus === "FLAGGED" || flagged) {
    return { status: "REVIEW", flagged: true, reason: reason || "needs_review", ageRestricted };
  }

  return { status: "SAFE", flagged: false, reason: null, ageRestricted };
};

const getVideoMetadata = async (_url: string) => ({
  duration: 0,
  resolution: "1080x1920"
});

const getClientDeviceInfo = (req: Request) => ({
  ip: req.ip,
  userAgent: req.headers["user-agent"] || null,
  deviceId: req.headers["x-device-id"] || null,
  platform: req.headers["x-platform"] || null,
  appVersion: req.headers["x-app-version"] || null
});

const canViewReel = async (reel: any, userId?: string) => {
  if (reel.moderationStatus === "BLOCKED" && reel.userId !== userId) return false;
  if (reel.visibility === "private" && reel.userId !== userId) return false;

  if (reel.visibility === "followers" && reel.userId !== userId) {
    if (!userId) return false;

    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    });

    if (!viewer?.following?.includes(reel.userId)) return false;
  }

  return true;
};

const publicReelWhere = {
  visibility: "public",
  moderationStatus: "SAFE",
  isDraft: false,
  publishedAt: { lte: new Date() }
};

const reelInclude = {
  author: {
    select: {
      id: true,
      username: true,
      fullName: true,
      avatarUrl: true,
      isVerified: true,
      followers: true,
      bio: true
    }
  },
  duetOf: {
    select: {
      id: true,
      thumbnailUrl: true,
      author: { select: { username: true } }
    }
  },
  stitchOf: {
    select: {
      id: true,
      thumbnailUrl: true,
      author: { select: { username: true } }
    }
  },
  _count: {
    select: {
      comments: true,
      duets: true,
      stitches: true
    }
  }
};

const ensureReelAccess = async (reelId: string, userId?: string) => {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    include: reelInclude
  });

  if (!reel) return { reel: null, error: { status: 404, message: "Reel not found" } };

  const allowed = await canViewReel(reel, userId);

  if (!allowed) return { reel: null, error: { status: 403, message: "Access denied" } };

  return { reel, error: null };
};

const createNotification = async (userId: string, type: NotificationType, title: string, body: string, data: any = {}) => {
  return prisma.notification
    .create({
      data: {
        userId,
        type,
        title,
        body,
        data,
        read: false
      }
    })
    .catch(() => null);
};

const updateReelEngagement = async (reelId: string) => {
  const [reel, comments, saves] = await Promise.all([
    prisma.reel.findUnique({ where: { id: reelId } }),
    prisma.comment.count({ where: { reelId, moderationStatus: "SAFE" } }),
    prisma.reelSave.count({ where: { reelId } })
  ]);

  if (!reel) return null;

  const engagementRate = reel.views > 0 ? (reel.likes.length + comments + reel.shares + saves) / reel.views : 0;
  const trendingScore = calculateTrendingScore({ ...reel, engagementRate, comments, saves });

  return prisma.reel.update({
    where: { id: reelId },
    data: { engagementRate, trendingScore }
  });
};

const createCoinTransaction = async (userId: string, amount: number, balance: number, source: WalletSource, referenceId: string, description: string, type: TransactionType) => {
  return prisma.coinTransaction
    .create({
      data: {
        userId,
        amount,
        balance,
        source,
        referenceId,
        description,
        type,
        status: TransactionStatus.SUCCESS
      }
    })
    .catch(() => null);
};

export const createReel = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const {
      caption,
      hashtags: inputHashtags,
      mentions,
      location,
      music,
      filters,
      effects,
      textOverlays,
      stickers,
      isDuet,
      duetOfId,
      isStitch,
      stitchOfId,
      visibility,
      ageRestricted,
      contentWarning,
      isDraft,
      scheduledFor,
      isSponsored,
      sponsorBrand,
      tipEnabled,
      category,
      language
    } = req.body;

    if (!req.file) return failure(res, 400, "Video file required");
    if (req.file.size > MAX_VIDEO_SIZE) return failure(res, 400, "File too large", { maxSize: MAX_VIDEO_SIZE });

    const finalCaption = cleanText(caption);
    const finalVisibility: Visibility = ["public", "followers", "private"].includes(String(visibility)) ? String(visibility) as Visibility : "public";
    const duetEnabled = toBool(isDuet);
    const stitchEnabled = toBool(isStitch);
    const scheduleDate = scheduledFor ? new Date(scheduledFor) : null;

    if (scheduleDate && Number.isNaN(scheduleDate.getTime())) return failure(res, 400, "Invalid schedule date");
    if (scheduleDate && scheduleDate <= new Date()) return failure(res, 400, "Schedule date must be in future");

    if (duetEnabled && duetOfId) {
      const original = await prisma.reel.findUnique({
        where: { id: String(duetOfId) },
        select: { id: true, userId: true, visibility: true, moderationStatus: true }
      });

      if (!original || original.userId === userId || original.moderationStatus === "BLOCKED" || original.visibility === "private") {
        return failure(res, 400, "Invalid duet target");
      }
    }

    if (stitchEnabled && stitchOfId) {
      const original = await prisma.reel.findUnique({
        where: { id: String(stitchOfId) },
        select: { id: true, userId: true, visibility: true, moderationStatus: true }
      });

      if (!original || original.userId === userId || original.moderationStatus === "BLOCKED" || original.visibility === "private") {
        return failure(res, 400, "Invalid stitch target");
      }
    }

    const moderation = normalizeModeration(await moderateContent({ text: finalCaption, userId }));

    if (moderation.status === "BLOCKED") {
      return failure(res, 400, "Content blocked by moderation", { reason: moderation.reason });
    }

    const draft = toBool(isDraft);
    const processingId = `proc_${Date.now()}_${userId}`;

    const reel = await prisma.reel.create({
      data: {
        userId,
        videoUrl: "",
        thumbnailUrl: "",
        duration: 0,
        resolution: "pending",
        fileSize: req.file.size,
        caption: finalCaption,
        hashtags: normalizeHashtags(finalCaption, inputHashtags),
        mentions: normalizeMentions(finalCaption, mentions),
        location: parseJson(location, null),
        music: parseJson(music, null),
        filters: parseJson(filters, {}),
        effects: parseJson<string[]>(effects, []),
        textOverlays: parseJson(textOverlays, []),
        stickers: parseJson(stickers, []),
        isDuet: duetEnabled,
        duetOfId: duetEnabled && duetOfId ? String(duetOfId) : null,
        isStitch: stitchEnabled,
        stitchOfId: stitchEnabled && stitchOfId ? String(stitchOfId) : null,
        visibility: finalVisibility,
        ageRestricted: toBool(ageRestricted) || moderation.ageRestricted,
        contentWarning: cleanText(contentWarning, 160) || null,
        moderationStatus: moderation.status,
        flaggedReason: moderation.flagged ? moderation.reason : null,
        isDraft: draft,
        scheduledFor: scheduleDate,
        isSponsored: toBool(isSponsored),
        sponsorBrand: cleanText(sponsorBrand, 80) || null,
        tipEnabled: toBool(tipEnabled, true),
        category: cleanText(category, 60) || null,
        language: cleanText(language, 12) || "en",
        encodingStatus: "processing",
        publishedAt: draft || scheduleDate || moderation.status !== "SAFE" ? null : new Date()
      }
    });

    success(
      res,
      {
        status: "processing",
        reelId: reel.id,
        processingId,
        message: "Video uploaded. Processing in background."
      },
      202
    );

    processReelUpload(reel.id, req.file, processingId).catch(async () => {
      await prisma.reel.update({
        where: { id: reel.id },
        data: { encodingStatus: "failed", moderationStatus: "REVIEW", flaggedReason: "processing_failed" }
      }).catch(() => null);

      io.to(`user:${userId}`).emit("reel:processing_failed", { reelId: reel.id, error: "Processing failed" });
    });
  } catch (error: any) {
    return failure(res, 500, "Failed to create reel", { code: error?.code || "CREATE_REEL_FAILED" });
  }
};

async function processReelUpload(reelId: string, file: Express.Multer.File, processingId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) return;

  try {
    io.to(`user:${reel.userId}`).emit("reel:processing_progress", { reelId, processingId, progress: 10 });

    const uploadResult = await uploadToCloudinary(file, "reels", {
      resource_type: "video",
      transformation: [
        { width: 1080, height: 1920, crop: "limit" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
        { bit_rate: "2500k" }
      ]
    });

    io.to(`user:${reel.userId}`).emit("reel:processing_progress", { reelId, processingId, progress: 35 });

    const [thumbnails, cdnUrls, metadata, moderationRaw] = await Promise.all([
      generateVideoThumbnails(uploadResult.secure_url, [0.1, 0.3, 0.5, 0.7, 0.9]),
      transcodeVideo(uploadResult.secure_url, reelId),
      getVideoMetadata(uploadResult.secure_url),
      moderateContent({
        videoUrl: uploadResult.secure_url,
        caption: reel.caption || "",
        userId: reel.userId
      })
    ]);

    const moderation = normalizeModeration(moderationRaw);

    io.to(`user:${reel.userId}`).emit("reel:processing_progress", { reelId, processingId, progress: 75 });

    const shouldPublish = !reel.isDraft && (!reel.scheduledFor || reel.scheduledFor <= new Date()) && moderation.status === "SAFE";

    const updated = await prisma.reel.update({
      where: { id: reelId },
      data: {
        videoUrl: uploadResult.secure_url,
        thumbnailUrl: thumbnails?.[0] || "",
        duration: metadata.duration,
        resolution: metadata.resolution,
        cdnUrls,
        moderationStatus: moderation.status,
        flaggedReason: moderation.flagged ? moderation.reason : null,
        ageRestricted: moderation.ageRestricted || reel.ageRestricted,
        encodingStatus: "completed",
        publishedAt: shouldPublish ? new Date() : reel.publishedAt
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true
          }
        },
        _count: {
          select: {
            comments: true
          }
        }
      }
    });

    const trendingScore = calculateTrendingScore(updated);

    await prisma.reel.update({
      where: { id: reelId },
      data: { trendingScore }
    });

    await Promise.all(
      updated.hashtags.map(tag =>
        prisma.trendingTag.upsert({
          where: { tag },
          update: {
            postCount: { increment: 1 },
            trendScore: { increment: 0.1 }
          },
          create: {
            tag,
            postCount: 1,
            trendScore: 0.1
          }
        })
      )
    );

    io.to(`user:${reel.userId}`).emit("reel:processing_progress", { reelId, processingId, progress: 100 });
    io.to(`user:${reel.userId}`).emit("reel:published", updated);

    if (shouldPublish && updated.visibility !== "private") {
      const followers = await prisma.user.findMany({
        where: { following: { has: reel.userId } },
        select: { id: true }
      });

      followers.forEach(follower => {
        io.to(`user:${follower.id}`).emit("feed:new_reel", {
          reel: updated,
          reason: "following"
        });
      });
    }
  } catch {
    await prisma.reel.update({
      where: { id: reelId },
      data: {
        encodingStatus: "failed",
        moderationStatus: "REVIEW",
        flaggedReason: "processing_failed"
      }
    }).catch(() => null);

    io.to(`user:${reel.userId}`).emit("reel:processing_failed", { reelId, error: "Processing failed" });
  }
}

export const getFeed = async (req: Request, res: Response) => {
  try {
    const { cursor, limit = DEFAULT_LIMIT, category, hashtag, forYou = "true", includeDrafts = "false" } = req.query;

    const userId = req.userId!;
    const take = getSafeLimit(limit);
    let reels: any[] = [];

    if (String(forYou) === "true") {
      reels = await generateFeedRanking(userId, {
        cursor: cursor as string,
        limit: take,
        category: category as string,
        excludeSeen: true
      });
    } else if (hashtag) {
      reels = await prisma.reel.findMany({
        where: {
          hashtags: { has: normalizeTag(String(hashtag)) },
          ...publicReelWhere
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true, followers: true } },
          _count: { select: { comments: true } }
        },
        cursor: cursor ? { id: String(cursor) } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: { publishedAt: "desc" },
        take
      });
    } else if (category) {
      reels = await prisma.reel.findMany({
        where: {
          category: String(category),
          ...publicReelWhere
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
          _count: { select: { comments: true } }
        },
        cursor: cursor ? { id: String(cursor) } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: [{ trendingScore: "desc" }, { publishedAt: "desc" }],
        take
      });
    } else {
      const following = await prisma.user.findUnique({
        where: { id: userId },
        select: { following: true }
      });

      const ids = following?.following?.length ? following.following : [userId];

      reels = await prisma.reel.findMany({
        where: {
          userId: { in: ids },
          visibility: { in: ["public", "followers"] },
          moderationStatus: "SAFE",
          publishedAt: { lte: new Date() },
          isDraft: String(includeDrafts) === "true" ? undefined : false
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
          _count: { select: { comments: true } }
        },
        cursor: cursor ? { id: String(cursor) } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: { publishedAt: "desc" },
        take
      });
    }

    const reelIds = reels.map(reel => reel.id);

    const [saved, progress] = await Promise.all([
      reelIds.length
        ? prisma.reelSave.findMany({
            where: { userId, reelId: { in: reelIds } },
            select: { reelId: true }
          })
        : [],
      reelIds.length
        ? prisma.watchProgress.findMany({
            where: { userId, reelId: { in: reelIds } },
            select: { reelId: true, progress: true }
          })
        : []
    ]);

    const savedSet = new Set(saved.map(item => item.reelId));
    const progressMap = new Map(progress.map(item => [item.reelId, item.progress]));

    const enriched = reels.map(reel => ({
      ...reel,
      isLiked: Array.isArray(reel.likes) ? reel.likes.includes(userId) : false,
      isSaved: savedSet.has(reel.id),
      watchProgress: progressMap.get(reel.id) || 0,
      engagementRate: reel.views > 0 ? ((reel.likes?.length || 0) + (reel._count?.comments || 0) + (reel.shares || 0)) / reel.views : 0
    }));

    const nextCursor = enriched.length === take ? enriched[enriched.length - 1]?.id : null;

    return success(res, { reels: enriched, nextCursor, hasMore: !!nextCursor });
  } catch {
    return failure(res, 500, "Failed to load feed");
  }
};

export const getTrending = async (req: Request, res: Response) => {
  try {
    const { category, limit = 20 } = req.query;
    const take = getSafeLimit(limit, 20);

    const reels = await prisma.reel.findMany({
      where: {
        visibility: "public",
        moderationStatus: "SAFE",
        publishedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), lte: new Date() },
        category: category ? String(category) : undefined,
        trendingScore: { gt: 0 },
        isDraft: false
      },
      include: {
        author: { select: { id: true, username: true, avatarUrl: true, isVerified: true, followers: true } },
        _count: { select: { comments: true } }
      },
      orderBy: [{ trendingScore: "desc" }, { publishedAt: "desc" }],
      take
    });

    return success(res, { reels });
  } catch {
    return failure(res, 500, "Failed to load trending reels");
  }
};

export const getReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const { reel, error } = await ensureReelAccess(id, userId);

    if (error) return failure(res, error.status, error.message);
    if (!reel) return failure(res, 404, "Reel not found");

    if (userId) trackView(reel.id, userId, req).catch(() => null);

    const [isSaved, watchProgress] = userId
      ? await Promise.all([
          prisma.reelSave.findUnique({ where: { reelId_userId: { reelId: id, userId } } }),
          prisma.watchProgress.findUnique({ where: { reelId_userId: { reelId: id, userId } } })
        ])
      : [null, null];

    return success(res, {
      reel: {
        ...reel,
        isLiked: userId ? reel.likes.includes(userId) : false,
        isSaved: !!isSaved,
        watchProgress: watchProgress?.progress || 0
      }
    });
  } catch {
    return failure(res, 500, "Failed to load reel");
  }
};

async function trackView(reelId: string, userId: string, req: Request) {
  const recent = await prisma.viewHistory.findFirst({
    where: {
      reelId,
      userId,
      watchedAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }
    }
  });

  if (recent) return;

  await prisma.$transaction([
    prisma.viewHistory.create({
      data: {
        reelId,
        userId,
        watchDuration: 0,
        completed: false,
        deviceInfo: getClientDeviceInfo(req)
      }
    }),
    prisma.reel.update({
      where: { id: reelId },
      data: {
        views: { increment: 1 },
        uniqueViews: { increment: 1 }
      }
    })
  ]);

  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    select: { views: true }
  });

  io.to(`reel:${reelId}`).emit("reel:view_update", { reelId, views: reel?.views || 0 });
}

export const likeReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const remove = toBool(req.body.remove);
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");

    const allowed = await canViewReel(reel, userId);
    if (!allowed) return failure(res, 403, "Access denied");

    const alreadyLiked = reel.likes.includes(userId);
    let likes = reel.likes;

    if (remove && alreadyLiked) likes = reel.likes.filter(lid => lid !== userId);
    if (!remove && !alreadyLiked) likes = [...reel.likes, userId];

    const updated = await prisma.reel.update({
      where: { id },
      data: { likes }
    });

    if (!remove && !alreadyLiked && reel.userId !== userId) {
      await createNotification(reel.userId, NotificationType.LIKE, "New reel like", "Someone liked your reel", { reelId: id, fromUserId: userId });
      io.to(`user:${reel.userId}`).emit("notification:like", {
        type: "reel_like",
        from: userId,
        reelId: id,
        timestamp: new Date()
      });
    }

    await updateReelEngagement(id);

    io.to(`reel:${id}`).emit("reel:like_update", {
      reelId: id,
      count: updated.likes.length,
      likedBy: userId,
      removed: remove
    });

    return success(res, { status: remove ? "unliked" : "liked", count: updated.likes.length });
  } catch {
    return failure(res, 500, "Failed to update like");
  }
};

export const saveReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { collectionId } = req.body;
    const remove = toBool(req.body.remove);
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");

    const allowed = await canViewReel(reel, userId);
    if (!allowed) return failure(res, 403, "Access denied");

    if (remove) {
      await prisma.reelSave.deleteMany({ where: { reelId: id, userId } });
      await prisma.reel.update({ where: { id }, data: { saves: { set: reel.saves.filter(item => item !== userId) } } }).catch(() => null);
      await updateReelEngagement(id);
      return success(res, { status: "unsaved" });
    }

    await prisma.reelSave.upsert({
      where: { reelId_userId: { reelId: id, userId } },
      update: { collectionId: collectionId ? String(collectionId) : null },
      create: { reelId: id, userId, collectionId: collectionId ? String(collectionId) : null }
    });

    if (!reel.saves.includes(userId)) {
      await prisma.reel.update({ where: { id }, data: { saves: { push: userId } } }).catch(() => null);
    }

    await updateReelEngagement(id);

    return success(res, { status: "saved" });
  } catch {
    return failure(res, 500, "Failed to save reel");
  }
};

export const shareReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { platform } = req.body;
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");

    const allowed = await canViewReel(reel, userId);
    if (!allowed) return failure(res, 403, "Access denied");

    await prisma.reelShare.create({
      data: {
        reelId: id,
        userId,
        platform: cleanText(platform, 40) || "unknown"
      }
    });

    const updated = await prisma.reel.update({
      where: { id },
      data: { shares: { increment: 1 } }
    });

    await updateReelEngagement(id);

    io.to(`reel:${id}`).emit("reel:share_update", {
      reelId: id,
      shares: updated.shares
    });

    return success(res, { status: "shared", shares: updated.shares });
  } catch {
    return failure(res, 500, "Failed to share reel");
  }
};

export const commentOnReel = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const { content, mediaUrl, replyToId } = req.body;
    const userId = req.userId!;
    const finalContent = cleanText(content, 1200);
    const finalMediaUrl = cleanText(mediaUrl, 1000);

    if (!finalContent && !finalMediaUrl) return failure(res, 400, "Comment content required");

    const moderation = normalizeModeration(await moderateContent({ text: finalContent, userId }));

    if (moderation.status === "BLOCKED") {
      return failure(res, 400, "Comment blocked by moderation", { reason: moderation.reason });
    }

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel) return failure(res, 404, "Reel not found");

    const allowed = await canViewReel(reel, userId);
    if (!allowed) return failure(res, 403, "Access denied");

    if (replyToId) {
      const parent = await prisma.comment.findUnique({ where: { id: String(replyToId) }, select: { id: true, reelId: true } });
      if (!parent || parent.reelId !== reelId) return failure(res, 400, "Invalid reply target");
    }

    const comment = await prisma.comment.create({
      data: {
        reelId,
        userId,
        content: finalContent || finalMediaUrl,
        mediaUrl: finalMediaUrl || null,
        replyToId: replyToId ? String(replyToId) : null,
        moderationStatus: moderation.status,
        isCreatorReply: reel.userId === userId
      },
      include: {
        user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        replyTo: { select: { id: true, content: true, user: { select: { username: true } } } }
      }
    });

    await updateReelEngagement(reelId);

    if (reel.userId !== userId && moderation.status === "SAFE") {
      await createNotification(reel.userId, NotificationType.COMMENT, "New reel comment", "Someone commented on your reel", { reelId, commentId: comment.id, fromUserId: userId });
      io.to(`user:${reel.userId}`).emit("notification:comment", {
        type: "reel_comment",
        from: userId,
        reelId,
        commentId: comment.id,
        timestamp: new Date()
      });
    }

    if (moderation.status === "SAFE") io.to(`reel:${reelId}`).emit("comment:new", comment);

    return success(res, { comment }, 201);
  } catch {
    return failure(res, 500, "Failed to comment");
  }
};

export const getComments = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const { cursor, limit = 20, sortBy = "recent" } = req.query;
    const take = getSafeLimit(limit, 20);

    const orderBy = String(sortBy) === "top" ? [{ createdAt: "desc" as const }] : [{ createdAt: "desc" as const }];

    const comments = await prisma.comment.findMany({
      where: {
        reelId,
        replyToId: null,
        moderationStatus: "SAFE"
      },
      include: {
        user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        replies: {
          where: { moderationStatus: "SAFE" },
          take: 3,
          include: { user: { select: { username: true, avatarUrl: true } } },
          orderBy: { createdAt: "asc" }
        },
        _count: { select: { replies: true } }
      },
      orderBy,
      cursor: cursor ? { id: String(cursor) } : undefined,
      skip: cursor ? 1 : 0,
      take: take + 1
    });

    const sorted = String(sortBy) === "top" ? comments.sort((a, b) => b.likes.length - a.likes.length || b.createdAt.getTime() - a.createdAt.getTime()) : comments;
    const hasMore = sorted.length > take;
    const result = hasMore ? sorted.slice(0, -1) : sorted;

    return success(res, {
      comments: result,
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch {
    return failure(res, 500, "Failed to load comments");
  }
};

export const createDuet = async (req: Request, res: Response) => {
  try {
    const { duetOfId } = req.body;
    const userId = req.userId!;

    const original = await prisma.reel.findUnique({
      where: { id: String(duetOfId || "") },
      select: { id: true, userId: true, visibility: true, moderationStatus: true }
    });

    if (!original) return failure(res, 404, "Original reel not found");
    if (original.userId === userId) return failure(res, 400, "Cannot duet your own reel");
    if (original.visibility === "private" || original.moderationStatus !== "SAFE") return failure(res, 403, "Duet not allowed");

    req.body.isDuet = "true";
    req.body.duetOfId = original.id;

    return createReel(req, res);
  } catch {
    return failure(res, 500, "Failed to create duet");
  }
};

export const createStitch = async (req: Request, res: Response) => {
  try {
    const { stitchOfId, clipStart = 0, clipEnd = 5 } = req.body;
    const userId = req.userId!;
    const start = toNumber(clipStart, 0, 0);
    const end = toNumber(clipEnd, 5, 0);

    const original = await prisma.reel.findUnique({
      where: { id: String(stitchOfId || "") },
      select: { id: true, userId: true, duration: true, visibility: true, moderationStatus: true }
    });

    if (!original) return failure(res, 404, "Original reel not found");
    if (original.userId === userId) return failure(res, 400, "Cannot stitch your own reel");
    if (original.visibility === "private" || original.moderationStatus !== "SAFE") return failure(res, 403, "Stitch not allowed");
    if (end <= start || end - start > 5 || (original.duration > 0 && end > original.duration)) return failure(res, 400, "Invalid stitch clip range");

    req.body.isStitch = "true";
    req.body.stitchOfId = original.id;
    req.body.stitchClip = JSON.stringify({ start, end });

    return createReel(req, res);
  } catch {
    return failure(res, 500, "Failed to create stitch");
  }
};

export const updateWatchProgress = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const userId = req.userId!;
    const progress = toNumber(req.body.progress, 0, 0, 1);
    const position = toNumber(req.body.position, 0, 0);

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel) return failure(res, 404, "Reel not found");

    const allowed = await canViewReel(reel, userId);
    if (!allowed) return failure(res, 403, "Access denied");

    await prisma.watchProgress.upsert({
      where: { reelId_userId: { reelId, userId } },
      update: {
        progress,
        lastPosition: position
      },
      create: {
        reelId,
        userId,
        progress,
        lastPosition: position
      }
    });

    if (progress >= 0.95) {
      await prisma.$transaction([
        prisma.viewHistory.updateMany({
          where: { reelId, userId, completed: false },
          data: { completed: true, watchDuration: position }
        }),
        prisma.reel.update({
          where: { id: reelId },
          data: { watchTime: { increment: position } }
        })
      ]);

      const [freshReel, completions] = await Promise.all([
        prisma.reel.findUnique({
          where: { id: reelId },
          select: { views: true }
        }),
        prisma.viewHistory.count({
          where: { reelId, completed: true }
        })
      ]);

      if (freshReel?.views) {
        await prisma.reel.update({
          where: { id: reelId },
          data: {
            completionRate: completions / freshReel.views,
            avgWatchPercent: progress
          }
        });
      }
    }

    return success(res, { status: "updated" });
  } catch {
    return failure(res, 500, "Failed to update watch progress");
  }
};

export const getReelAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");
    if (reel.userId !== userId) return failure(res, 403, "Access denied");

    const [viewHistory, comments, saves, shares] = await Promise.all([
      prisma.viewHistory.findMany({
        where: { reelId: id, watchedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        select: { watchedAt: true, watchDuration: true, completed: true, deviceInfo: true },
        orderBy: { watchedAt: "desc" },
        take: 100
      }),
      prisma.comment.count({ where: { reelId: id, moderationStatus: "SAFE" } }),
      prisma.reelSave.count({ where: { reelId: id } }),
      prisma.reelShare.count({ where: { reelId: id } })
    ]);

    const hourlyViews = Array.from({ length: 24 }).map((_, index) => {
      const hourStart = new Date(Date.now() - (23 - index) * 60 * 60 * 1000);
      const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
      return {
        hour: hourStart.toISOString(),
        views: viewHistory.filter(item => item.watchedAt >= hourStart && item.watchedAt < hourEnd).length
      };
    });

    return success(res, {
      reel: {
        id: reel.id,
        views: reel.views,
        uniqueViews: reel.uniqueViews,
        likes: reel.likes.length,
        comments,
        shares: reel.shares || shares,
        saves,
        engagementRate: reel.engagementRate,
        avgWatchPercent: reel.avgWatchPercent,
        completionRate: reel.completionRate,
        tipsReceived: reel.tipsReceived
      },
      hourlyViews,
      retentionCurve: viewHistory.map(item => ({
        watchedAt: item.watchedAt,
        watchDuration: item.watchDuration,
        completed: item.completed
      })),
      trafficSource: {},
      recentViews: viewHistory
    });
  } catch {
    return failure(res, 500, "Failed to load analytics");
  }
};

export const tipCreator = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const amount = Math.floor(toNumber(req.body.amount, 0, 1, 100000));
    const message = cleanText(req.body.message, 240);
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || !reel.tipEnabled) return failure(res, 400, "Tipping not enabled");
    if (reel.userId === userId) return failure(res, 400, "Cannot tip yourself");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.coins < amount) return failure(res, 400, "Insufficient coins");

    const creator = await prisma.user.findUnique({ where: { id: reel.userId } });
    if (!creator) return failure(res, 404, "Creator not found");

    await prisma.$transaction(async tx => {
      const sender = await tx.user.update({ where: { id: userId }, data: { coins: { decrement: amount } } });
      const receiver = await tx.user.update({ where: { id: reel.userId }, data: { coins: { increment: amount } } });

      await tx.reel.update({ where: { id: reelId }, data: { tipsReceived: { increment: amount } } });

      await tx.creatorEconomy.upsert({
        where: { userId: reel.userId },
        update: { totalEarnings: { increment: amount }, pendingPayout: { increment: amount } },
        create: { userId: reel.userId, totalEarnings: amount, pendingPayout: amount }
      });

      await tx.coinTransaction.create({
        data: {
          userId,
          amount,
          balance: sender.coins,
          source: WalletSource.GIFT,
          referenceId: reelId,
          description: "Reel creator tip sent",
          type: TransactionType.DEBIT,
          status: TransactionStatus.SUCCESS
        }
      });

      await tx.coinTransaction.create({
        data: {
          userId: reel.userId,
          amount,
          balance: receiver.coins,
          source: WalletSource.GIFT,
          referenceId: reelId,
          description: "Reel creator tip received",
          type: TransactionType.CREDIT,
          status: TransactionStatus.SUCCESS
        }
      });
    });

    await createNotification(reel.userId, NotificationType.GIFT, "New tip received", "Someone tipped your reel", { reelId, fromUserId: userId, amount, message });

    io.to(`user:${reel.userId}`).emit("notification:tip", {
      type: "reel_tip",
      from: userId,
      reelId,
      amount,
      message,
      timestamp: new Date()
    });

    return success(res, { status: "tipped", newBalance: user.coins - amount });
  } catch {
    return failure(res, 500, "Failed to tip creator");
  }
};

export const reportReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reason = cleanText(req.body.reason, 80);
    const details = cleanText(req.body.details, 1000);
    const userId = req.userId!;

    if (!reason) return failure(res, 400, "Report reason required");

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");

    const existing = await prisma.reelReport.findFirst({
      where: { reelId: id, reporterId: userId }
    });

    if (existing) {
      await prisma.reelReport.update({
        where: { id: existing.id },
        data: { reason, details, status: "pending" }
      });
    } else {
      await prisma.reelReport.create({
        data: { reelId: id, reporterId: userId, reason, details }
      });
    }

    const reportCount = await prisma.reelReport.count({
      where: { reelId: id, status: "pending" }
    });

    if (reportCount >= 5) {
      await prisma.reel.update({
        where: { id },
        data: {
          moderationStatus: "REVIEW",
          flaggedReason: "multiple_reports"
        }
      });

      io.to("admin").emit("reel:flagged", { reelId: id, reportCount });
    }

    return success(res, { status: "reported" });
  } catch {
    return failure(res, 500, "Failed to report reel");
  }
};

export const getDrafts = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const drafts = await prisma.reel.findMany({
      where: { userId, isDraft: true },
      include: {
        author: { select: { username: true } },
        _count: { select: { comments: true } }
      },
      orderBy: { updatedAt: "desc" }
    });

    return success(res, { drafts });
  } catch {
    return failure(res, 500, "Failed to load drafts");
  }
};

export const scheduleReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;
    const userId = req.userId!;
    const date = new Date(scheduledFor);

    if (!scheduledFor || Number.isNaN(date.getTime()) || date <= new Date()) {
      return failure(res, 400, "Valid future schedule date required");
    }

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return failure(res, 404, "Reel not found");
    if (reel.userId !== userId) return failure(res, 403, "Access denied");

    await prisma.reel.update({
      where: { id },
      data: {
        isDraft: false,
        scheduledFor: date,
        publishedAt: null
      }
    });

    return success(res, { status: "scheduled", scheduledFor: date });
  } catch {
    return failure(res, 500, "Failed to schedule reel");
  }
};

export const collaborate = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const inviteeUsername = normalizeUsername(cleanText(req.body.inviteeUsername, 40));
    const role = cleanText(req.body.role, 40) || "featured";
    const revenueShare = toNumber(req.body.revenueShare, 0.5, 0, 1);
    const userId = req.userId!;

    if (!inviteeUsername) return failure(res, 400, "Invitee username required");

    const invitee = await prisma.user.findUnique({ where: { username: inviteeUsername } });
    if (!invitee) return failure(res, 404, "User not found");
    if (invitee.id === userId) return failure(res, 400, "Cannot invite yourself");

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel) return failure(res, 404, "Reel not found");
    if (reel.userId !== userId) return failure(res, 403, "Access denied");

    const existing = await prisma.collaboration.findFirst({
      where: { reelId, inviteeId: invitee.id }
    });

    const collaboration = existing
      ? await prisma.collaboration.update({
          where: { id: existing.id },
          data: {
            role,
            revenueShare,
            status: "pending",
            respondedAt: null
          },
          include: {
            initiator: { select: { username: true } },
            invitee: { select: { username: true } }
          }
        })
      : await prisma.collaboration.create({
          data: {
            reelId,
            initiatorId: userId,
            inviteeId: invitee.id,
            role,
            revenueShare
          },
          include: {
            initiator: { select: { username: true } },
            invitee: { select: { username: true } }
          }
        });

    await createNotification(invitee.id, NotificationType.SYSTEM, "Collaboration invite", "You received a reel collaboration invite", { reelId, collaborationId: collaboration.id, fromUserId: userId });

    io.to(`user:${invitee.id}`).emit("collaboration:invite", collaboration);

    return success(res, { collaboration }, 201);
  } catch {
    return failure(res, 500, "Failed to create collaboration invite");
  }
};

export const respondToCollaboration = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const accept = toBool(req.body.accept);
    const userId = req.userId!;

    const collab = await prisma.collaboration.findUnique({
      where: { id },
      include: { reel: true }
    });

    if (!collab || collab.inviteeId !== userId) return failure(res, 403, "Access denied");

    const updated = await prisma.collaboration.update({
      where: { id },
      data: {
        status: accept ? "accepted" : "declined",
        respondedAt: new Date()
      }
    });

    await createNotification(collab.initiatorId, NotificationType.SYSTEM, "Collaboration response", accept ? "Your collaboration invite was accepted" : "Your collaboration invite was declined", {
      collaborationId: id,
      reelId: collab.reelId,
      inviteeId: userId,
      accepted: accept
    });

    io.to(`user:${collab.initiatorId}`).emit("collaboration:response", {
      collaborationId: id,
      accepted: accept,
      reelId: collab.reelId
    });

    return success(res, { status: accept ? "accepted" : "declined", collaboration: updated });
  } catch {
    return failure(res, 500, "Failed to respond to collaboration");
  }
};
