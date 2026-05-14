import { Request, Response } from "express";
import { prisma } from "../config/db";
import { uploadToCloudinary, generateThumbnails } from "../utils/media";
import { io } from "../app";
import { moderateContent } from "../services/contentModeration";

type JsonValue = any;

const STORY_MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const STORY_MAX_VIDEO_SIZE = 250 * 1024 * 1024;
const STORY_IMAGE_DURATION = 5;
const STORY_VIDEO_DURATION = 15;
const STORY_EXPIRY_HOURS = 24;
const STORY_CAPTION_MAX = 2200;
const STORY_MAX_ALLOWED_USERS = 5000;
const STORY_MAX_HIDE_USERS = 5000;
const STORY_MAX_STICKERS = 50;
const STORY_MAX_TEXT_OVERLAYS = 50;
const STORY_MAX_HASHTAGS = 30;
const STORY_MAX_MENTIONS = 50;
const STORY_MAX_REPLY_TEXT = 2200;
const STORY_MAX_HIGHLIGHT_NAME = 80;
const STORY_MAX_HIGHLIGHT_FOLDER = 80;

const ok = (res: Response, data: any, status = 200) => res.status(status).json(data);

const fail = (res: Response, status: number, error: string, message?: string) =>
  res.status(status).json({
    error,
    message: process.env.NODE_ENV === "development" ? message : undefined
  });

const parseJson = <T = JsonValue>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
};

const parseNumber = (value: unknown, fallback: number, min?: number, max?: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (typeof min === "number" && floored < min) return min;
  if (typeof max === "number" && floored > max) return max;
  return floored;
};

const cleanText = (value: unknown, max = 500) => {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, max);
};

const normalizeCaption = (caption: unknown): string => cleanText(caption, STORY_CAPTION_MAX);

const normalizeStringArray = (value: unknown, limit = 1000, maxText = 120): string[] => {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim().startsWith("[")
      ? parseJson<string[]>(value, [])
      : typeof value === "string"
        ? value.split(/[,\n]/)
        : [];

  if (!Array.isArray(parsed)) return [];

  return Array.from(
    new Set(
      parsed
        .map(v => cleanText(v, maxText))
        .filter(Boolean)
    )
  ).slice(0, limit);
};

const normalizeStickerArray = (value: unknown) => {
  const parsed = parseJson<any[]>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, STORY_MAX_STICKERS);
};

const normalizeTextOverlays = (value: unknown) => {
  const parsed = parseJson<any[]>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, STORY_MAX_TEXT_OVERLAYS).map(item => ({
    ...item,
    text: cleanText(item?.text, 500)
  }));
};

const extractHashtagsFromText = (text: string): string[] => {
  return Array.from(
    new Set(
      (text.match(/#[\p{L}\p{N}_]+/gu) || [])
        .map(tag => tag.replace("#", "").toLowerCase())
        .filter(Boolean)
    )
  ).slice(0, STORY_MAX_HASHTAGS);
};

const extractMentionsFromText = (text: string): string[] => {
  return Array.from(
    new Set(
      (text.match(/@[\p{L}\p{N}_.]+/gu) || [])
        .map(tag => tag.replace("@", "").toLowerCase())
        .filter(Boolean)
    )
  ).slice(0, STORY_MAX_MENTIONS);
};

const normalizeHashtags = (value: unknown, caption: string) => {
  const explicit = normalizeStringArray(value, STORY_MAX_HASHTAGS, 80)
    .map(tag => tag.replace(/^#/, "").toLowerCase())
    .filter(Boolean);
  return explicit.length ? explicit : extractHashtagsFromText(caption);
};

const normalizeMentions = (value: unknown, caption: string) => {
  const explicit = normalizeStringArray(value, STORY_MAX_MENTIONS, 80)
    .map(tag => tag.replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return explicit.length ? explicit : extractMentionsFromText(caption);
};

const getExpiryDate = () => {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + STORY_EXPIRY_HOURS);
  return expiresAt;
};

const isVideoFile = (file: Express.Multer.File) => Boolean(file.mimetype?.startsWith("video"));

const isImageFile = (file: Express.Multer.File) => Boolean(file.mimetype?.startsWith("image"));

const assertStoryFile = (file?: Express.Multer.File) => {
  if (!file) return "Media required";
  const video = isVideoFile(file);
  const image = isImageFile(file);
  if (!video && !image) return "Only image or video story media is allowed";
  if (image && file.size > STORY_MAX_IMAGE_SIZE) return "Image story is too large";
  if (video && file.size > STORY_MAX_VIDEO_SIZE) return "Video story is too large";
  return null;
};

const normalizeVisibility = (value: unknown) => {
  const visibility = cleanText(value, 40).toLowerCase();
  if (["all", "public", "everyone"].includes(visibility)) return "all";
  if (["followers", "private", "selected", "custom", "close_friends"].includes(visibility)) return visibility;
  return "all";
};

const getStorySelect = () => ({
  id: true,
  userId: true,
  mediaUrl: true,
  mediaType: true,
  duration: true,
  thumbnailUrl: true,
  caption: true,
  music: true,
  stickers: true,
  filters: true,
  textOverlays: true,
  visibility: true,
  allowedUsers: true,
  hideFrom: true,
  allowReplies: true,
  allowReactions: true,
  linkStickers: true,
  pollSticker: true,
  questionSticker: true,
  countdownSticker: true,
  locationSticker: true,
  hashtagStickers: true,
  mentionStickers: true,
  isHighlight: true,
  highlightName: true,
  highlightFolder: true,
  expiresAt: true,
  createdAt: true,
  views: true,
  viewers: true,
  reactions: true,
  linkClicks: true,
  moderationStatus: true,
  archived: true,
  author: {
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
      replies: true
    }
  }
});

const canViewStory = async (story: any, viewerId: string) => {
  if (!story || !viewerId) return false;
  if (story.userId === viewerId) return true;
  if (story.archived && !story.isHighlight) return false;
  if (story.moderationStatus && story.moderationStatus !== "approved") return false;
  if (story.expiresAt && new Date(story.expiresAt).getTime() <= Date.now() && !story.isHighlight) return false;
  if (Array.isArray(story.hideFrom) && story.hideFrom.includes(viewerId)) return false;

  const visibility = story.visibility || "all";

  if (visibility === "private") return false;

  if (visibility === "selected" || visibility === "custom") {
    return Array.isArray(story.allowedUsers) && story.allowedUsers.includes(viewerId);
  }

  if (visibility === "close_friends") {
    const cf = await prisma.closeFriendsList.findUnique({
      where: { ownerUserId: story.userId }
    }).catch(() => null);

    return Boolean(cf?.memberUserIds?.includes(viewerId));
  }

  if (visibility === "followers") {
    const viewer = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { following: true }
    });

    return Boolean(viewer?.following?.includes(story.userId));
  }

  return true;
};

const ensureConversation = async (userA: string, userB: string) => {
  const existing = await prisma.conversation.findFirst({
    where: {
      type: "direct",
      AND: [
        { participants: { some: { userId: userA } } },
        { participants: { some: { userId: userB } } }
      ]
    },
    select: { id: true }
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      type: "direct",
      participants: {
        create: [
          { userId: userA },
          { userId: userB }
        ]
      }
    },
    select: { id: true }
  });
};

const calculateReactionCount = (reactions: any) => {
  return Object.values((reactions || {}) as Record<string, any[]>).reduce((sum, users: any) => {
    return sum + (Array.isArray(users) ? users.length : 0);
  }, 0);
};

const calculateRetention = (story: any) => {
  const views = Number(story?.views || 0);
  const replies = Number(story?._count?.replies || 0);
  const reactions = calculateReactionCount(story?.reactions);
  const linkClicks = Number(story?.linkClicks || 0);
  if (!views) return 0;
  return Math.min(1, Number(((replies * 0.35 + reactions * 0.25 + linkClicks * 0.4) / views).toFixed(4)));
};

const uploadStoryMedia = async (file: Express.Multer.File, video: boolean) => {
  const result = await uploadToCloudinary(file, "stories", {
    resource_type: video ? "video" : "image",
    transformation: [
      { quality: "auto:good", fetch_format: "auto" },
      ...(video
        ? [{ width: 1080, height: 1920, crop: "limit", duration: STORY_VIDEO_DURATION }]
        : [{ width: 1080, height: 1920, crop: "limit" }])
    ]
  });

  const secureUrl = typeof result === "string" ? result : result?.secure_url || result?.url || "";

  if (!secureUrl) throw new Error("Media upload failed");

  return {
    ...result,
    secure_url: secureUrl
  };
};

const createNotification = async (userId: string, type: string, title: string, body: string, data: any) => {
  await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      data,
      read: false
    } as any
  }).catch(() => null);
};

const emitToFollowers = async (authorId: string, hideFrom: string[], payload: any) => {
  const followers = await prisma.user.findMany({
    where: { following: { has: authorId } },
    select: { id: true }
  });

  followers.forEach(f => {
    if (!hideFrom.includes(f.id)) {
      io.to(`user:${f.id}`).emit("story:new", payload);
    }
  });
};

export const createStory = async (req: Request, res: Response) => {
  try {
    const fileError = assertStoryFile(req.file);
    if (fileError) return fail(res, 400, fileError);

    const userId = req.userId!;
    const file = req.file!;
    const video = isVideoFile(file);
    const caption = normalizeCaption(req.body.caption);
    const visibility = normalizeVisibility(req.body.visibility);
    const allowedUsers = normalizeStringArray(req.body.allowedUsers, STORY_MAX_ALLOWED_USERS, 80);
    const hideFrom = normalizeStringArray(req.body.hideFrom, STORY_MAX_HIDE_USERS, 80);
    const isHighlight = parseBoolean(req.body.isHighlight, false);
    const hashtagStickers = normalizeHashtags(req.body.hashtags, caption);
    const mentionStickers = normalizeMentions(req.body.mentions, caption);

    if (visibility === "close_friends") {
      const cf = await prisma.closeFriendsList.findUnique({
        where: { ownerUserId: userId }
      }).catch(() => null);

      if (!cf?.memberUserIds?.length) {
        return fail(res, 400, "Close Friends list is empty");
      }
    }

    if ((visibility === "selected" || visibility === "custom") && !allowedUsers.length) {
      return fail(res, 400, "Selected visibility requires allowed users");
    }

    const moderation = await moderateContent({
      mediaUrl: (file as any).path || file.filename || file.originalname,
      videoUrl: video ? ((file as any).path || file.originalname) : undefined,
      text: caption,
      caption,
      userId
    } as any).catch(() => ({
      flagged: false,
      status: "approved",
      reason: null
    }));

    if (moderation.flagged || moderation.status === "rejected") {
      return res.status(400).json({
        error: "Content violates community guidelines",
        reason: moderation.reason || "moderation_failed"
      });
    }

    const uploadResult = await uploadStoryMedia(file, video);

    const thumbnailResult = video
      ? await generateThumbnails(uploadResult.secure_url, [0.1]).catch(() => [])
      : [uploadResult.secure_url];

    const thumbnailUrl = Array.isArray(thumbnailResult) && thumbnailResult.length
      ? thumbnailResult[0]
      : uploadResult.secure_url;

    const duration = video
      ? parseNumber(req.body.duration, STORY_VIDEO_DURATION, 1, STORY_VIDEO_DURATION)
      : parseNumber(req.body.duration, STORY_IMAGE_DURATION, 1, 30);

    const story = await prisma.story.create({
      data: {
        userId,
        mediaUrl: uploadResult.secure_url,
        mediaType: video ? "video" : "image",
        duration,
        thumbnailUrl,
        caption,
        music: parseJson(req.body.music, null),
        stickers: normalizeStickerArray(req.body.stickers),
        filters: parseJson(req.body.filters, {}),
        textOverlays: normalizeTextOverlays(req.body.textOverlays),
        visibility,
        allowedUsers,
        hideFrom,
        allowReplies: parseBoolean(req.body.allowReplies, true),
        allowReactions: parseBoolean(req.body.allowReactions, true),
        linkStickers: parseJson(req.body.linkStickers, null),
        pollSticker: parseJson(req.body.pollSticker, null),
        questionSticker: parseJson(req.body.questionSticker, null),
        countdownSticker: parseJson(req.body.countdownSticker, null),
        locationSticker: parseJson(req.body.locationSticker, null),
        hashtagStickers,
        mentionStickers,
        isHighlight,
        highlightName: isHighlight ? cleanText(req.body.highlightName, STORY_MAX_HIGHLIGHT_NAME) || null : null,
        highlightFolder: isHighlight ? cleanText(req.body.highlightFolder, STORY_MAX_HIGHLIGHT_FOLDER) || null : null,
        expiresAt: getExpiryDate(),
        moderationStatus: moderation.status === "pending" ? "pending" : "approved",
        archived: false,
        reactions: {},
        views: 0,
        viewers: [],
        linkClicks: 0
      },
      include: {
        author: {
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

    if (story.moderationStatus === "approved") {
      await emitToFollowers(userId, hideFrom, {
        storyId: story.id,
        author: story.author,
        thumbnailUrl: story.thumbnailUrl,
        mediaType: story.mediaType,
        createdAt: story.createdAt
      });
    }

    io.to(`user:${userId}`).emit("story:created", story);

    await prisma.user.update({
      where: { id: userId },
      data: { xp: { increment: 5 } }
    }).catch(() => null);

    return ok(res, story, 201);
  } catch (err: any) {
    return fail(res, 500, "Failed to create story", err?.message);
  }
};

export const getActiveStories = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { following: true }
    });

    const followedIds = currentUser?.following || [];
    const candidateIds = [...new Set([...followedIds, userId])];

    const stories = await prisma.story.findMany({
      where: {
        userId: { in: candidateIds },
        OR: [
          { expiresAt: { gt: new Date() } },
          { isHighlight: true }
        ],
        moderationStatus: "approved",
        archived: false
      },
      include: getStorySelect(),
      orderBy: [{ createdAt: "desc" }]
    });

    const visibleStories: any[] = [];

    for (const story of stories) {
      if (await canViewStory(story, userId)) {
        visibleStories.push({
          ...story,
          viewed: Array.isArray(story.viewers) && story.viewers.includes(userId)
        });
      }
    }

    const grouped = visibleStories.reduce((acc, story) => {
      const uid = story.author.id;

      if (!acc[uid]) {
        acc[uid] = {
          author: story.author,
          stories: [],
          viewedCount: 0,
          totalCount: 0,
          latestAt: story.createdAt
        };
      }

      acc[uid].stories.push(story);
      acc[uid].totalCount += 1;
      if (story.viewed) acc[uid].viewedCount += 1;

      if (new Date(story.createdAt).getTime() > new Date(acc[uid].latestAt).getTime()) {
        acc[uid].latestAt = story.createdAt;
      }

      return acc;
    }, {} as Record<string, any>);

    const result = Object.values(grouped).sort((a: any, b: any) => {
      const aUnseen = a.totalCount - a.viewedCount;
      const bUnseen = b.totalCount - b.viewedCount;
      if (aUnseen !== bUnseen) return bUnseen - aUnseen;
      return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
    });

    return ok(res, result);
  } catch (err: any) {
    return fail(res, 500, "Failed to load active stories", err?.message);
  }
};

export const getUserStories = async (req: Request, res: Response) => {
  try {
    const viewerId = req.userId!;
    const { userId } = req.params;

    const stories = await prisma.story.findMany({
      where: {
        userId,
        OR: [
          { expiresAt: { gt: new Date() } },
          { isHighlight: true }
        ],
        moderationStatus: "approved",
        archived: false
      },
      include: getStorySelect(),
      orderBy: { createdAt: "asc" }
    });

    const visible: any[] = [];

    for (const story of stories) {
      if (await canViewStory(story, viewerId)) {
        visible.push({
          ...story,
          viewed: Array.isArray(story.viewers) && story.viewers.includes(viewerId)
        });
      }
    }

    return ok(res, visible);
  } catch (err: any) {
    return fail(res, 500, "Failed to load user stories", err?.message);
  }
};

export const viewStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot view this story");
    }

    const viewers = Array.isArray(story.viewers) ? story.viewers : [];

    if (viewers.includes(userId)) {
      return ok(res, {
        alreadyViewed: true,
        totalViews: story.views
      });
    }

    const updated = await prisma.story.update({
      where: { id },
      data: {
        views: { increment: 1 },
        viewers: { push: userId }
      },
      select: {
        id: true,
        userId: true,
        views: true
      }
    });

    io.to(`user:${story.userId}`).emit("story:view", {
      storyId: id,
      viewerId: userId,
      totalViews: updated.views
    });

    return ok(res, {
      status: "viewed",
      totalViews: updated.views
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to mark story as viewed", err?.message);
  }
};

export const replyToStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const content = cleanText(req.body.content, STORY_MAX_REPLY_TEXT);
    const mediaUrl = req.body.mediaUrl ? String(req.body.mediaUrl).trim() : null;

    if (!content && !mediaUrl) {
      return fail(res, 400, "Reply content or media is required");
    }

    const story = await prisma.story.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatarUrl: true
          }
        }
      }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot reply to this story");
    }

    if (!story.allowReplies) {
      return fail(res, 403, "Replies are disabled for this story");
    }

    const moderation = await moderateContent({
      text: content,
      userId
    } as any).catch(() => ({
      flagged: false,
      status: "approved"
    }));

    if (moderation.flagged || moderation.status === "rejected") {
      return fail(res, 400, "Reply violates community guidelines");
    }

    const reply = await prisma.storyReply.create({
      data: {
        storyId: id,
        userId,
        content,
        mediaUrl
      },
      include: {
        user: {
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

    if (story.userId !== userId) {
      const conversation = await ensureConversation(userId, story.userId);

      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          content: content ? `[Story Reply] ${content}` : "[Story Reply]",
          mediaUrl: mediaUrl || undefined,
          replyToMediaUrl: story.mediaUrl
        } as any
      });

      io.to(`conversation:${conversation.id}`).emit("message:new", message);

      await createNotification(
        story.userId,
        "MESSAGE",
        "New story reply",
        content || "Someone replied to your story",
        {
          storyId: id,
          from: userId,
          conversationId: conversation.id
        }
      );
    }

    io.to(`user:${story.userId}`).emit("story:reply", {
      storyId: id,
      reply
    });

    return ok(res, reply, 201);
  } catch (err: any) {
    return fail(res, 500, "Failed to reply to story", err?.message);
  }
};

export const reactToStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const reaction = cleanText(req.body.reaction || req.body.emoji, 20);

    if (!reaction) return fail(res, 400, "Reaction required");

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot react to this story");
    }

    if (!story.allowReactions) {
      return fail(res, 403, "Reactions are disabled for this story");
    }

    const reactions = { ...((story.reactions as any) || {}) };

    Object.keys(reactions).forEach(key => {
      if (Array.isArray(reactions[key])) {
        reactions[key] = reactions[key].filter((uid: string) => uid !== userId);
      }
    });

    if (!Array.isArray(reactions[reaction])) reactions[reaction] = [];
    reactions[reaction] = Array.from(new Set([...reactions[reaction], userId]));

    const updated = await prisma.story.update({
      where: { id },
      data: { reactions },
      select: {
        id: true,
        userId: true,
        reactions: true
      }
    });

    if (story.userId !== userId) {
      await createNotification(
        story.userId,
        "STORY",
        "New story reaction",
        "Someone reacted to your story",
        {
          storyId: id,
          from: userId,
          reaction
        }
      );
    }

    io.to(`user:${story.userId}`).emit("story:reaction", {
      storyId: id,
      userId,
      reaction
    });

    return ok(res, {
      status: "reacted",
      reactions: updated.reactions
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to react to story", err?.message);
  }
};

export const removeStoryReaction = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot update this story reaction");
    }

    const reactions = { ...((story.reactions as any) || {}) };

    Object.keys(reactions).forEach(key => {
      if (Array.isArray(reactions[key])) {
        reactions[key] = reactions[key].filter((uid: string) => uid !== userId);
      }
    });

    const updated = await prisma.story.update({
      where: { id },
      data: { reactions },
      select: { reactions: true }
    });

    io.to(`user:${story.userId}`).emit("story:reaction_removed", {
      storyId: id,
      userId
    });

    return ok(res, {
      status: "removed",
      reactions: updated.reactions
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to remove reaction", err?.message);
  }
};

export const voteOnPoll = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const optionIndex = parseNumber(req.body.optionIndex, -1);
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot vote on this story");
    }

    const poll = { ...((story.pollSticker as any) || {}) };

    if (!poll || !Array.isArray(poll.options)) {
      return fail(res, 400, "No poll available");
    }

    if (optionIndex < 0 || optionIndex >= poll.options.length) {
      return fail(res, 400, "Invalid poll option");
    }

    poll.options = poll.options.map((option: any) => ({
      ...option,
      votes: Array.isArray(option.votes) ? option.votes.filter((uid: string) => uid !== userId) : []
    }));

    poll.options[optionIndex].votes = Array.from(new Set([...(poll.options[optionIndex].votes || []), userId]));
    poll.totalVotes = poll.options.reduce((sum: number, option: any) => sum + (Array.isArray(option.votes) ? option.votes.length : 0), 0);

    const updated = await prisma.story.update({
      where: { id },
      data: { pollSticker: poll },
      select: {
        pollSticker: true,
        userId: true
      }
    });

    io.to(`story:${id}`).emit("poll:update", {
      storyId: id,
      optionIndex,
      total: poll.totalVotes,
      poll: updated.pollSticker
    });

    io.to(`user:${story.userId}`).emit("story:poll_vote", {
      storyId: id,
      voterId: userId,
      optionIndex,
      total: poll.totalVotes
    });

    return ok(res, {
      status: "voted",
      total: poll.totalVotes,
      poll: updated.pollSticker
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to vote on poll", err?.message);
  }
};

export const answerQuestionSticker = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const answer = normalizeCaption(req.body.answer);

    if (!answer) return fail(res, 400, "Answer required");

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot answer this story");
    }

    const question = { ...((story.questionSticker as any) || {}) };

    if (!question || Object.keys(question).length === 0) {
      return fail(res, 400, "No question sticker available");
    }

    const moderation = await moderateContent({
      text: answer,
      userId
    } as any).catch(() => ({
      flagged: false,
      status: "approved"
    }));

    if (moderation.flagged || moderation.status === "rejected") {
      return fail(res, 400, "Answer violates community guidelines");
    }

    const answers = Array.isArray(question.answers) ? question.answers : [];

    question.answers = [
      ...answers.filter((item: any) => item.userId !== userId),
      {
        userId,
        answer,
        createdAt: new Date()
      }
    ];

    const updated = await prisma.story.update({
      where: { id },
      data: { questionSticker: question },
      select: { questionSticker: true }
    });

    io.to(`user:${story.userId}`).emit("story:question_answer", {
      storyId: id,
      userId,
      answer
    });

    return ok(res, {
      status: "answered",
      questionSticker: updated.questionSticker
    }, 201);
  } catch (err: any) {
    return fail(res, 500, "Failed to answer question", err?.message);
  }
};

export const trackStoryLinkClick = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");

    if (!(await canViewStory(story, userId))) {
      return fail(res, 403, "You cannot open this story link");
    }

    const updated = await prisma.story.update({
      where: { id },
      data: { linkClicks: { increment: 1 } },
      select: {
        linkClicks: true,
        userId: true
      }
    });

    io.to(`user:${story.userId}`).emit("story:link_click", {
      storyId: id,
      userId,
      linkClicks: updated.linkClicks
    });

    return ok(res, {
      status: "tracked",
      linkClicks: updated.linkClicks
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to track link click", err?.message);
  }
};

export const createHighlight = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const name = cleanText(req.body.name, STORY_MAX_HIGHLIGHT_NAME);
    const folder = cleanText(req.body.folder || req.body.highlightFolder, STORY_MAX_HIGHLIGHT_FOLDER);
    const storyIds = normalizeStringArray(req.body.storyIds, 100, 80);

    if (!name) return fail(res, 400, "Highlight name required");
    if (!storyIds.length) return fail(res, 400, "Select at least one story");

    const stories = await prisma.story.findMany({
      where: {
        id: { in: storyIds },
        userId
      },
      orderBy: { createdAt: "asc" }
    });

    if (!stories.length) {
      return fail(res, 404, "No valid stories found");
    }

    const cover = cleanText(req.body.coverUrl, 1000) || stories[0]?.thumbnailUrl || stories[0]?.mediaUrl;

    const highlight = await prisma.storyHighlight.create({
      data: {
        userId,
        name,
        coverUrl: cover,
        stories: stories.map(s => ({
          storyId: s.id,
          mediaUrl: s.mediaUrl,
          thumbnailUrl: s.thumbnailUrl,
          mediaType: s.mediaType,
          duration: s.duration,
          createdAt: s.createdAt
        }))
      }
    });

    await prisma.story.updateMany({
      where: {
        id: { in: stories.map(s => s.id) },
        userId
      },
      data: {
        isHighlight: true,
        highlightName: name,
        highlightFolder: folder || null,
        archived: false,
        archivedAt: null
      }
    });

    io.to(`user:${userId}`).emit("story:highlight_created", highlight);

    return ok(res, highlight, 201);
  } catch (err: any) {
    return fail(res, 500, "Failed to create highlight", err?.message);
  }
};

export const getHighlights = async (req: Request, res: Response) => {
  try {
    const viewerId = req.userId;
    const { userId } = req.params;

    const highlights = await prisma.storyHighlight.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" }
    });

    if (!viewerId || viewerId === userId) return ok(res, highlights);

    const filtered = [];

    for (const highlight of highlights as any[]) {
      const storyIds = Array.isArray(highlight.stories) ? highlight.stories.map((s: any) => s.storyId).filter(Boolean) : [];

      if (!storyIds.length) {
        filtered.push(highlight);
        continue;
      }

      const stories = await prisma.story.findMany({
        where: {
          id: { in: storyIds },
          userId
        }
      });

      const visibleStories = [];

      for (const story of stories) {
        if (await canViewStory({ ...story, isHighlight: true }, viewerId)) {
          visibleStories.push(story.id);
        }
      }

      if (visibleStories.length) {
        filtered.push({
          ...highlight,
          stories: Array.isArray((highlight as any).stories)
            ? (highlight as any).stories.filter((s: any) => visibleStories.includes(s.storyId))
            : []
        });
      }
    }

    return ok(res, filtered);
  } catch (err: any) {
    return fail(res, 500, "Failed to load highlights", err?.message);
  }
};

export const deleteStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");
    if (story.userId !== userId) return fail(res, 403, "Access denied");

    await prisma.story.update({
      where: { id },
      data: {
        archived: true,
        archivedAt: new Date()
      }
    });

    io.to(`user:${userId}`).emit("story:deleted", { storyId: id });

    return ok(res, { status: "deleted" });
  } catch (err: any) {
    return fail(res, 500, "Failed to delete story", err?.message);
  }
};

export const getStoryViewers = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id },
      select: {
        userId: true,
        viewers: true
      }
    });

    if (!story) return fail(res, 404, "Story not found");
    if (story.userId !== userId) return fail(res, 403, "Access denied");

    const viewerIds = Array.isArray(story.viewers) ? story.viewers : [];

    const viewers = await prisma.user.findMany({
      where: {
        id: { in: viewerIds }
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    const order = new Map(viewerIds.map((id: string, index: number) => [id, index]));

    viewers.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

    return ok(res, viewers);
  } catch (err: any) {
    return fail(res, 500, "Failed to load story viewers", err?.message);
  }
};

export const getStoryAnalytics = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findFirst({
      where: {
        id,
        userId
      },
      include: {
        _count: {
          select: {
            replies: true
          }
        }
      }
    });

    if (!story) return fail(res, 404, "Not found");

    const reactions = (story.reactions as any) || {};

    const reactionBreakdown = Object.keys(reactions).reduce((acc, key) => {
      acc[key] = Array.isArray(reactions[key]) ? reactions[key].length : 0;
      return acc;
    }, {} as Record<string, number>);

    const poll = story.pollSticker as any;
    const pollVotes = poll?.options?.reduce((sum: number, option: any) => sum + (Array.isArray(option.votes) ? option.votes.length : 0), 0) || 0;

    const question = story.questionSticker as any;
    const questionAnswers = Array.isArray(question?.answers) ? question.answers.length : 0;

    return ok(res, {
      storyId: story.id,
      views: story.views,
      uniqueViewers: Array.isArray(story.viewers) ? story.viewers.length : 0,
      replies: story._count?.replies || 0,
      linkClicks: story.linkClicks || 0,
      pollVotes,
      questionAnswers,
      reactions: reactionBreakdown,
      totalReactions: calculateReactionCount(story.reactions),
      viewers: story.viewers,
      retention: calculateRetention(story),
      createdAt: story.createdAt,
      expiresAt: story.expiresAt
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to load story analytics", err?.message);
  }
};

export const archiveStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");
    if (story.userId !== userId) return fail(res, 403, "Access denied");

    const updated = await prisma.story.update({
      where: { id },
      data: {
        archived: true,
        archivedAt: new Date()
      }
    });

    io.to(`user:${userId}`).emit("story:archived", { storyId: id });

    return ok(res, updated);
  } catch (err: any) {
    return fail(res, 500, "Failed to archive story", err?.message);
  }
};

export const restoreStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return fail(res, 404, "Story not found");
    if (story.userId !== userId) return fail(res, 403, "Access denied");

    const expired = story.expiresAt && new Date(story.expiresAt).getTime() <= Date.now() && !story.isHighlight;

    if (expired) return fail(res, 400, "Expired story cannot be restored unless it is a highlight");

    const updated = await prisma.story.update({
      where: { id },
      data: {
        archived: false,
        archivedAt: null
      }
    });

    io.to(`user:${userId}`).emit("story:restored", { storyId: id });

    return ok(res, updated);
  } catch (err: any) {
    return fail(res, 500, "Failed to restore story", err?.message);
  }
};

export const getMyStoryArchive = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = parseNumber(req.query.limit, 30, 1, 100);
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    const stories = await prisma.story.findMany({
      where: {
        userId,
        archived: true
      },
      include: getStorySelect(),
      orderBy: { createdAt: "desc" },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take: limit + 1
    });

    const hasMore = stories.length > limit;
    const result = hasMore ? stories.slice(0, -1) : stories;

    return ok(res, {
      stories: result,
      nextCursor: hasMore ? result[result.length - 1]?.id : null,
      hasMore
    });
  } catch (err: any) {
    return fail(res, 500, "Failed to load story archive", err?.message);
  }
};

export const expireStories = async () => {
  const expired = await prisma.story.findMany({
    where: {
      expiresAt: { lt: new Date() },
      archived: false,
      isHighlight: false
    }
  });

  for (const story of expired) {
    await prisma.story.update({
      where: { id: story.id },
      data: {
        archived: true,
        archivedAt: new Date()
      }
    });

    io.to(`user:${story.userId}`).emit("story:expired", {
      storyId: story.id
    });
  }

  return {
    expired: expired.length
  };
};
