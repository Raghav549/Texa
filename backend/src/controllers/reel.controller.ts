import { Request, Response } from "express";
import { prisma } from "../config/db";
import { uploadToCloudinary, generateVideoThumbnails, transcodeVideo } from "../utils/media";
import { io } from "../app";
import { calculateTrendingScore, generateFeedRanking } from "../services/feedAlgorithm";
import { moderateContent } from "../services/contentModeration";
import { extractHashtags, extractMentions } from "../utils/messageParser";

type Visibility = "public" | "followers" | "private";

const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const toBool = (value: unknown, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
};

const toNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clippedMin = typeof min === "number" ? Math.max(n, min) : n;
  return typeof max === "number" ? Math.min(clippedMin, max) : clippedMin;
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
  return value.trim().slice(0, max);
};

const normalizeTag = (tag: string) => tag.replace(/^#/, "").trim().toLowerCase();

const normalizeHashtags = (caption: string, input?: unknown) => {
  const raw = Array.isArray(input) ? input : typeof input === "string" && input.trim().startsWith("[") ? parseJson<string[]>(input, []) : typeof input === "string" ? input.split(/[,\s]+/) : [];
  const extracted = extractHashtags(caption);
  return Array.from(new Set([...raw.map(String), ...extracted].map(normalizeTag).filter(Boolean))).slice(0, 30);
};

const normalizeMentions = (caption: string, input?: unknown) => {
  const raw = Array.isArray(input) ? input : typeof input === "string" && input.trim().startsWith("[") ? parseJson<string[]>(input, []) : typeof input === "string" ? input.split(/[,\s]+/) : [];
  const extracted = extractMentions(caption);
  return Array.from(new Set([...raw.map(String), ...extracted].map(v => v.replace(/^@/, "").trim()).filter(Boolean))).slice(0, 50);
};

const getSafeLimit = (limit: unknown, fallback = DEFAULT_LIMIT) => toNumber(limit, fallback, 1, MAX_LIMIT);

const getVideoMetadata = async (_url: string) => ({
  duration: 0,
  resolution: "1080x1920"
});

const ensureReelAccess = async (reelId: string, userId?: string) => {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    include: {
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
      music: true,
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
          likes: true,
          comments: true,
          duets: true,
          stitches: true
        }
      }
    }
  });

  if (!reel) return { reel: null, error: { status: 404, message: "Reel not found" } };

  if (reel.visibility === "private" && reel.userId !== userId) {
    return { reel: null, error: { status: 403, message: "Private reel" } };
  }

  if (reel.visibility === "followers" && reel.userId !== userId) {
    if (!userId) return { reel: null, error: { status: 403, message: "Followers only" } };
    const viewer = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    });
    if (!viewer?.following?.includes(reel.userId)) {
      return { reel: null, error: { status: 403, message: "Followers only" } };
    }
  }

  return { reel, error: null };
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

    if (!req.file) return res.status(400).json({ error: "Video file required" });
    if (req.file.size > MAX_VIDEO_SIZE) return res.status(400).json({ error: "File too large (max 500MB)" });

    const finalCaption = cleanText(caption);
    const finalVisibility: Visibility = ["public", "followers", "private"].includes(String(visibility)) ? visibility : "public";
    const duetEnabled = toBool(isDuet);
    const stitchEnabled = toBool(isStitch);

    if (duetEnabled && duetOfId) {
      const original = await prisma.reel.findUnique({
        where: { id: duetOfId },
        select: { id: true, userId: true, allowDuets: true }
      });
      if (!original || original.userId === userId) return res.status(400).json({ error: "Invalid duet target" });
      if (original.allowDuets === false) return res.status(403).json({ error: "Duets disabled by creator" });
    }

    if (stitchEnabled && stitchOfId) {
      const original = await prisma.reel.findUnique({
        where: { id: stitchOfId },
        select: { id: true, userId: true, allowStitches: true }
      });
      if (!original || original.userId === userId) return res.status(400).json({ error: "Invalid stitch target" });
      if (original.allowStitches === false) return res.status(403).json({ error: "Stitches disabled by creator" });
    }

    const moderation = await moderateContent({ text: finalCaption, userId });
    if (moderation.flagged && moderation.status === "rejected") {
      return res.status(400).json({ error: "Content rejected by moderation", reason: moderation.reason });
    }

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
        effects: parseJson(effects, []),
        textOverlays: parseJson(textOverlays, []),
        stickers: parseJson(stickers, []),
        isDuet: duetEnabled,
        duetOfId: duetEnabled ? duetOfId || null : null,
        isStitch: stitchEnabled,
        stitchOfId: stitchEnabled ? stitchOfId || null : null,
        visibility: finalVisibility,
        ageRestricted: toBool(ageRestricted) || !!moderation.ageRestricted,
        contentWarning: cleanText(contentWarning, 160) || null,
        moderationStatus: moderation.status || "pending",
        flaggedReason: moderation.flagged ? moderation.reason || null : null,
        isDraft: toBool(isDraft),
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        isSponsored: toBool(isSponsored),
        sponsorBrand: cleanText(sponsorBrand, 80) || null,
        tipEnabled: !toBool(tipEnabled, true) ? false : true,
        category: cleanText(category, 60) || null,
        language: cleanText(language, 12) || "en",
        encodingStatus: "processing",
        publishedAt: toBool(isDraft) || scheduledFor ? null : new Date()
      }
    });

    res.status(202).json({
      status: "processing",
      reelId: reel.id,
      processingId,
      message: "Video uploaded. Processing in background."
    });

    processReelUpload(reel.id, req.file, processingId).catch(async () => {
      await prisma.reel.update({
        where: { id: reel.id },
        data: { encodingStatus: "failed", moderationStatus: "rejected" }
      });
      io.to(`user:${userId}`).emit("reel:processing_failed", { reelId: reel.id, error: "Processing failed" });
    });
  } catch {
    res.status(500).json({ error: "Failed to create reel" });
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

    const [thumbnails, cdnUrls, metadata, moderation] = await Promise.all([
      generateVideoThumbnails(uploadResult.secure_url, [0.1, 0.3, 0.5, 0.7, 0.9]),
      transcodeVideo(uploadResult.secure_url, reelId),
      getVideoMetadata(uploadResult.secure_url),
      moderateContent({
        videoUrl: uploadResult.secure_url,
        caption: reel.caption || "",
        userId: reel.userId
      })
    ]);

    io.to(`user:${reel.userId}`).emit("reel:processing_progress", { reelId, processingId, progress: 75 });

    const shouldPublish = !reel.isDraft && (!reel.scheduledFor || reel.scheduledFor <= new Date()) && moderation.status !== "rejected";

    const updated = await prisma.reel.update({
      where: { id: reelId },
      data: {
        videoUrl: uploadResult.secure_url,
        thumbnailUrl: thumbnails?.[0] || "",
        duration: metadata.duration,
        resolution: metadata.resolution,
        cdnUrls,
        moderationStatus: moderation.status || "approved",
        flaggedReason: moderation.flagged ? moderation.reason || null : null,
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
        music: true,
        _count: {
          select: {
            likes: true,
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
        moderationStatus: "rejected"
      }
    });
    io.to(`user:${reel.userId}`).emit("reel:processing_failed", { reelId, error: "Processing failed" });
  }
}

export const getFeed = async (req: Request, res: Response) => {
  try {
    const {
      cursor,
      limit = DEFAULT_LIMIT,
      category,
      hashtag,
      forYou = "true",
      includeDrafts = "false"
    } = req.query;

    const userId = req.userId!;
    const take = getSafeLimit(limit);
    let reels: any[] = [];

    if (forYou === "true") {
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
          visibility: "public",
          moderationStatus: "approved",
          publishedAt: { lte: new Date() },
          isDraft: false
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true, followers: true } },
          music: true,
          _count: { select: { likes: true, comments: true } }
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
          visibility: "public",
          moderationStatus: "approved",
          publishedAt: { lte: new Date() },
          isDraft: false
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
          music: true,
          _count: { select: { likes: true, comments: true } }
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

      reels = await prisma.reel.findMany({
        where: {
          userId: { in: following?.following?.length ? following.following : [userId] },
          visibility: { in: ["public", "followers"] },
          moderationStatus: "approved",
          publishedAt: { lte: new Date() },
          isDraft: includeDrafts === "true" ? undefined : false
        },
        include: {
          author: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
          music: true,
          _count: { select: { likes: true, comments: true } }
        },
        cursor: cursor ? { id: String(cursor) } : undefined,
        skip: cursor ? 1 : 0,
        orderBy: { publishedAt: "desc" },
        take
      });
    }

    const reelIds = reels.map(reel => reel.id);

    const [saved, progress] = await Promise.all([
      prisma.reelSave.findMany({
        where: { userId, reelId: { in: reelIds } },
        select: { reelId: true }
      }),
      prisma.watchProgress.findMany({
        where: { userId, reelId: { in: reelIds } },
        select: { reelId: true, progress: true }
      })
    ]);

    const savedSet = new Set(saved.map(item => item.reelId));
    const progressMap = new Map(progress.map(item => [item.reelId, item.progress]));

    const enriched = reels.map(reel => ({
      ...reel,
      isLiked: Array.isArray(reel.likes) ? reel.likes.includes(userId) : false,
      isSaved: savedSet.has(reel.id),
      watchProgress: progressMap.get(reel.id) || 0,
      engagementRate:
        reel.views > 0
          ? ((reel._count?.likes || reel.likes?.length || 0) + (reel._count?.comments || 0) + (reel.shares || 0)) / reel.views
          : 0
    }));

    if (enriched.length) {
      await prisma.feedImpression.create({
        data: {
          userId,
          reelIds: enriched.map(reel => reel.id),
          feedType: forYou === "true" ? "for_you" : "following"
        }
      }).catch(() => null);
    }

    const nextCursor = enriched.length === take ? enriched[enriched.length - 1]?.id : null;
    res.json({ reels: enriched, nextCursor, hasMore: !!nextCursor });
  } catch {
    res.status(500).json({ error: "Failed to load feed" });
  }
};

export const getTrending = async (req: Request, res: Response) => {
  try {
    const { category, limit = 20 } = req.query;
    const take = getSafeLimit(limit, 20);

    const reels = await prisma.reel.findMany({
      where: {
        visibility: "public",
        moderationStatus: "approved",
        publishedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        category: category ? String(category) : undefined,
        NOT: { trendingScore: 0 }
      },
      include: {
        author: { select: { id: true, username: true, avatarUrl: true, isVerified: true, followers: true } },
        music: true,
        _count: { select: { likes: true, comments: true, shares: true } }
      },
      orderBy: [{ trendingScore: "desc" }, { publishedAt: "desc" }],
      take
    });

    res.json(reels);
  } catch {
    res.status(500).json({ error: "Failed to load trending reels" });
  }
};

export const getReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    const { reel, error } = await ensureReelAccess(id, userId);
    if (error) return res.status(error.status).json({ error: error.message });
    if (!reel) return res.status(404).json({ error: "Reel not found" });

    if (userId) trackView(reel.id, userId, req).catch(() => null);

    const [isSaved, watchProgress] = userId
      ? await Promise.all([
          prisma.reelSave.findUnique({ where: { reelId_userId: { reelId: id, userId } } }),
          prisma.watchProgress.findUnique({ where: { reelId_userId: { reelId: id, userId } } })
        ])
      : [null, null];

    res.json({
      ...reel,
      isLiked: userId ? reel.likes.includes(userId) : false,
      isSaved: !!isSaved,
      watchProgress: watchProgress?.progress || 0
    });
  } catch {
    res.status(500).json({ error: "Failed to load reel" });
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
        deviceInfo: {
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          deviceId: req.headers["x-device-id"]
        }
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

  io.to(`reel:${reelId}`).emit("reel:view_update", { views: reel?.views || 0 });
}

export const likeReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const remove = toBool(req.body.remove);
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel) return res.status(404).json({ error: "Reel not found" });

    const alreadyLiked = reel.likes.includes(userId);
    let likes = reel.likes;

    if (remove && alreadyLiked) {
      likes = reel.likes.filter(lid => lid !== userId);
    }

    if (!remove && !alreadyLiked) {
      likes = [...reel.likes, userId];
    }

    const updated = await prisma.reel.update({
      where: { id },
      data: { likes }
    });

    if (!remove && !alreadyLiked && reel.userId !== userId) {
      io.to(`user:${reel.userId}`).emit("notification:like", {
        type: "reel_like",
        from: userId,
        reelId: id,
        timestamp: new Date()
      });
    }

    const comments = await prisma.comment.count({ where: { reelId: id } });
    const engagementRate = updated.views > 0 ? (updated.likes.length + comments + updated.shares) / updated.views : 0;

    await prisma.reel.update({
      where: { id },
      data: {
        engagementRate,
        trendingScore: calculateTrendingScore({ ...updated, engagementRate })
      }
    });

    io.to(`reel:${id}`).emit("reel:like_update", {
      reelId: id,
      count: likes.length,
      likedBy: userId,
      removed: remove
    });

    res.json({ status: remove ? "unliked" : "liked", count: likes.length });
  } catch {
    res.status(500).json({ error: "Failed to update like" });
  }
};

export const saveReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { collectionId } = req.body;
    const remove = toBool(req.body.remove);
    const userId = req.userId!;

    if (remove) {
      await prisma.reelSave.deleteMany({ where: { reelId: id, userId } });
      return res.json({ status: "unsaved" });
    }

    await prisma.reelSave.upsert({
      where: { reelId_userId: { reelId: id, userId } },
      update: { collectionId: collectionId || null },
      create: { reelId: id, userId, collectionId: collectionId || null }
    });

    res.json({ status: "saved" });
  } catch {
    res.status(500).json({ error: "Failed to save reel" });
  }
};

export const shareReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { platform } = req.body;
    const userId = req.userId!;

    await prisma.reelShare.create({
      data: {
        reelId: id,
        userId,
        platform: cleanText(platform, 40) || "unknown"
      }
    });

    const reel = await prisma.reel.update({
      where: { id },
      data: { shares: { increment: 1 } }
    });

    await prisma.reel.update({
      where: { id },
      data: { trendingScore: calculateTrendingScore(reel) }
    });

    io.to(`reel:${id}`).emit("reel:share_update", {
      reelId: id,
      shares: reel.shares
    });

    res.json({ status: "shared", shares: reel.shares });
  } catch {
    res.status(500).json({ error: "Failed to share reel" });
  }
};

export const commentOnReel = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const { content, mediaUrl, replyToId } = req.body;
    const userId = req.userId!;
    const finalContent = cleanText(content, 1200);

    if (!finalContent && !mediaUrl) return res.status(400).json({ error: "Comment content required" });

    const moderation = await moderateContent({ text: finalContent, userId });
    if (moderation.flagged && moderation.status === "rejected") {
      return res.status(400).json({ error: "Comment contains inappropriate content" });
    }

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel) return res.status(404).json({ error: "Reel not found" });

    const comment = await prisma.comment.create({
      data: {
        reelId,
        userId,
        content: finalContent,
        mediaUrl: mediaUrl || null,
        replyToId: replyToId || null,
        moderationStatus: moderation.status || "approved",
        isCreatorReply: reel.userId === userId
      },
      include: {
        user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        replyTo: { select: { id: true, content: true, user: { select: { username: true } } } }
      }
    });

    if (reel.userId !== userId) {
      io.to(`user:${reel.userId}`).emit("notification:comment", {
        type: "reel_comment",
        from: userId,
        reelId,
        commentId: comment.id,
        timestamp: new Date()
      });
    }

    io.to(`reel:${reelId}`).emit("comment:new", comment);
    res.status(201).json(comment);
  } catch {
    res.status(500).json({ error: "Failed to comment" });
  }
};

export const getComments = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const { cursor, limit = 20, sortBy = "recent" } = req.query;
    const take = getSafeLimit(limit, 20);

    const comments = await prisma.comment.findMany({
      where: {
        reelId,
        replyToId: null,
        moderationStatus: "approved"
      },
      include: {
        user: { select: { id: true, username: true, avatarUrl: true, isVerified: true } },
        replies: {
          take: 3,
          include: { user: { select: { username: true, avatarUrl: true } } },
          orderBy: { createdAt: "asc" }
        },
        _count: { select: { replies: true, likes: true } }
      },
      orderBy: sortBy === "top" ? [{ likesCount: "desc" as const }, { createdAt: "desc" as const }] : { createdAt: "desc" },
      cursor: cursor ? { id: String(cursor) } : undefined,
      skip: cursor ? 1 : 0,
      take: take + 1
    });

    const hasMore = comments.length > take;
    const result = hasMore ? comments.slice(0, -1) : comments;

    res.json({
      comments: result,
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch {
    res.status(500).json({ error: "Failed to load comments" });
  }
};

export const createDuet = async (req: Request, res: Response) => {
  try {
    const { duetOfId, layout = "side_by_side" } = req.body;
    const userId = req.userId!;

    const original = await prisma.reel.findUnique({
      where: { id: duetOfId },
      select: { id: true, userId: true, duration: true, resolution: true, allowDuets: true }
    });

    if (!original) return res.status(404).json({ error: "Original reel not found" });
    if (original.userId === userId) return res.status(400).json({ error: "Cannot duet your own reel" });
    if (original.allowDuets === false) return res.status(403).json({ error: "Duets disabled" });

    req.body.isDuet = "true";
    req.body.duetOfId = duetOfId;
    req.body.duetLayout = layout;

    return createReel(req, res);
  } catch {
    res.status(500).json({ error: "Failed to create duet" });
  }
};

export const createStitch = async (req: Request, res: Response) => {
  try {
    const { stitchOfId, clipStart = 0, clipEnd = 5 } = req.body;
    const userId = req.userId!;
    const start = toNumber(clipStart, 0, 0);
    const end = toNumber(clipEnd, 5, 0);

    const original = await prisma.reel.findUnique({
      where: { id: stitchOfId },
      select: { id: true, userId: true, duration: true, allowStitches: true }
    });

    if (!original) return res.status(404).json({ error: "Original reel not found" });
    if (original.userId === userId) return res.status(400).json({ error: "Cannot stitch your own reel" });
    if (original.allowStitches === false) return res.status(403).json({ error: "Stitches disabled" });
    if (end <= start || end - start > 5 || end > original.duration) return res.status(400).json({ error: "Invalid stitch clip range" });

    req.body.isStitch = "true";
    req.body.stitchOfId = stitchOfId;
    req.body.stitchClip = JSON.stringify({ start, end });

    return createReel(req, res);
  } catch {
    res.status(500).json({ error: "Failed to create stitch" });
  }
};

export const updateWatchProgress = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const userId = req.userId!;
    const progress = toNumber(req.body.progress, 0, 0, 1);
    const position = toNumber(req.body.position, 0, 0);

    await prisma.watchProgress.upsert({
      where: { reelId_userId: { reelId, userId } },
      update: {
        progress,
        lastPosition: position,
        updatedAt: new Date()
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

      const reel = await prisma.reel.findUnique({
        where: { id: reelId },
        select: { views: true }
      });

      const completions = await prisma.viewHistory.count({
        where: { reelId, completed: true }
      });

      if (reel?.views) {
        await prisma.reel.update({
          where: { id: reelId },
          data: {
            completionRate: completions / reel.views,
            avgWatchPercent: progress
          }
        });
      }
    }

    res.json({ status: "updated" });
  } catch {
    res.status(500).json({ error: "Failed to update watch progress" });
  }
};

export const getReelAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel || reel.userId !== userId) return res.status(403).json({ error: "Access denied" });

    const analytics = await prisma.reelAnalytics.upsert({
      where: { reelId: id },
      update: {},
      create: { reelId: id }
    });

    const [viewHistory, comments, saves] = await Promise.all([
      prisma.viewHistory.findMany({
        where: { reelId: id, watchedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        select: { watchedAt: true, watchDuration: true, completed: true, deviceInfo: true },
        orderBy: { watchedAt: "desc" },
        take: 100
      }),
      prisma.comment.count({ where: { reelId: id } }),
      prisma.reelSave.count({ where: { reelId: id } })
    ]);

    res.json({
      reel: {
        id: reel.id,
        views: reel.views,
        likes: reel.likes.length,
        comments,
        shares: reel.shares,
        saves,
        engagementRate: reel.engagementRate,
        avgWatchPercent: reel.avgWatchPercent,
        completionRate: reel.completionRate,
        tipsReceived: reel.tipsReceived
      },
      hourlyViews: analytics.hourlyViews,
      retentionCurve: analytics.retentionCurve,
      trafficSource: analytics.trafficSource,
      recentViews: viewHistory
    });
  } catch {
    res.status(500).json({ error: "Failed to load analytics" });
  }
};

export const tipCreator = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const amount = toNumber(req.body.amount, 0, 1, 100000);
    const message = cleanText(req.body.message, 240);
    const userId = req.userId!;

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || !reel.tipEnabled) return res.status(400).json({ error: "Tipping not enabled" });
    if (reel.userId === userId) return res.status(400).json({ error: "Cannot tip yourself" });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.coins < amount) return res.status(400).json({ error: "Insufficient coins" });

    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { coins: { decrement: amount } } }),
      prisma.user.update({ where: { id: reel.userId }, data: { coins: { increment: amount } } }),
      prisma.reel.update({ where: { id: reelId }, data: { tipsReceived: { increment: amount } } }),
      prisma.creatorFund.upsert({
        where: { userId: reel.userId },
        update: { totalEarnings: { increment: amount } },
        create: { userId: reel.userId, totalEarnings: amount }
      })
    ]);

    io.to(`user:${reel.userId}`).emit("notification:tip", {
      type: "reel_tip",
      from: userId,
      reelId,
      amount,
      message,
      timestamp: new Date()
    });

    res.json({ status: "tipped", newBalance: user.coins - amount });
  } catch {
    res.status(500).json({ error: "Failed to tip creator" });
  }
};

export const reportReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reason = cleanText(req.body.reason, 80);
    const details = cleanText(req.body.details, 1000);
    const userId = req.userId!;

    if (!reason) return res.status(400).json({ error: "Report reason required" });

    await prisma.reelReport.upsert({
      where: { reelId_reporterId: { reelId: id, reporterId: userId } },
      update: { reason, details, status: "pending", updatedAt: new Date() },
      create: { reelId: id, reporterId: userId, reason, details }
    });

    const reportCount = await prisma.reelReport.count({
      where: { reelId: id, status: "pending" }
    });

    if (reportCount >= 5) {
      await prisma.reel.update({
        where: { id },
        data: {
          moderationStatus: "flagged",
          flaggedReason: "multiple_reports"
        }
      });
      io.to("admin:moderation").emit("reel:flagged", { reelId: id, reportCount });
    }

    res.json({ status: "reported" });
  } catch {
    res.status(500).json({ error: "Failed to report reel" });
  }
};

export const getDrafts = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const drafts = await prisma.reel.findMany({
      where: { userId, isDraft: true },
      include: {
        author: { select: { username: true } },
        _count: { select: { likes: true } }
      },
      orderBy: { updatedAt: "desc" }
    });

    res.json(drafts);
  } catch {
    res.status(500).json({ error: "Failed to load drafts" });
  }
};

export const scheduleReel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;
    const userId = req.userId!;
    const date = new Date(scheduledFor);

    if (!scheduledFor || Number.isNaN(date.getTime()) || date <= new Date()) {
      return res.status(400).json({ error: "Valid future schedule date required" });
    }

    const reel = await prisma.reel.findUnique({ where: { id } });
    if (!reel || reel.userId !== userId) return res.status(403).json({ error: "Access denied" });

    await prisma.reel.update({
      where: { id },
      data: {
        isDraft: false,
        scheduledFor: date,
        publishedAt: null
      }
    });

    res.json({ status: "scheduled", scheduledFor: date });
  } catch {
    res.status(500).json({ error: "Failed to schedule reel" });
  }
};

export const collaborate = async (req: Request, res: Response) => {
  try {
    const { reelId } = req.params;
    const inviteeUsername = cleanText(req.body.inviteeUsername, 40);
    const role = cleanText(req.body.role, 40) || "featured";
    const revenueShare = toNumber(req.body.revenueShare, 0.5, 0, 1);
    const userId = req.userId!;

    const invitee = await prisma.user.findUnique({ where: { username: inviteeUsername } });
    if (!invitee) return res.status(404).json({ error: "User not found" });
    if (invitee.id === userId) return res.status(400).json({ error: "Cannot invite yourself" });

    const reel = await prisma.reel.findUnique({ where: { id: reelId } });
    if (!reel || reel.userId !== userId) return res.status(403).json({ error: "Access denied" });

    const collaboration = await prisma.collaboration.upsert({
      where: { reelId_inviteeId: { reelId, inviteeId: invitee.id } },
      update: {
        role,
        revenueShare,
        status: "pending",
        respondedAt: null
      },
      create: {
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

    io.to(`user:${invitee.id}`).emit("collaboration:invite", collaboration);
    res.status(201).json(collaboration);
  } catch {
    res.status(500).json({ error: "Failed to create collaboration invite" });
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

    if (!collab || collab.inviteeId !== userId) return res.status(403).json({ error: "Access denied" });

    const updated = await prisma.collaboration.update({
      where: { id },
      data: {
        status: accept ? "accepted" : "declined",
        respondedAt: new Date()
      }
    });

    io.to(`user:${collab.initiatorId}`).emit("collaboration:response", {
      collaborationId: id,
      accepted: accept,
      reelId: collab.reelId
    });

    if (accept && collab.reel) {
      await prisma.reel.update({
        where: { id: collab.reelId },
        data: {
          collaborators: {
            push: {
              userId,
              role: collab.role,
              revenueShare: collab.revenueShare,
              acceptedAt: new Date()
            }
          }
        }
      }).catch(() => null);
    }

    res.json({ status: accept ? "accepted" : "declined", collaboration: updated });
  } catch {
    res.status(500).json({ error: "Failed to respond to collaboration" });
  }
};
