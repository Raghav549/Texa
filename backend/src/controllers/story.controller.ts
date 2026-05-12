import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { uploadToCloudinary, generateThumbnails } from '../utils/media';
import { io } from '../app';
import { moderateContent } from '../services/contentModeration';

type JsonValue = any;

const STORY_MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const STORY_MAX_VIDEO_SIZE = 250 * 1024 * 1024;
const STORY_IMAGE_DURATION = 5;
const STORY_VIDEO_DURATION = 15;
const STORY_EXPIRY_HOURS = 24;

const parseJson = <T = JsonValue>(value: unknown, fallback: T): T => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const parseNumber = (value: unknown, fallback: number, min?: number, max?: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (typeof min === 'number' && floored < min) return min;
  if (typeof max === 'number' && floored > max) return max;
  return floored;
};

const normalizeStringArray = (value: unknown): string[] => {
  const parsed = parseJson<string[]>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(v => String(v).trim()).filter(Boolean);
};

const normalizeCaption = (caption: unknown): string => {
  return String(caption || '').trim().slice(0, 2200);
};

const extractHashtagsFromText = (text: string): string[] => {
  return Array.from(new Set((text.match(/#[\p{L}\p{N}_]+/gu) || []).map(tag => tag.replace('#', '').toLowerCase())));
};

const extractMentionsFromText = (text: string): string[] => {
  return Array.from(new Set((text.match(/@[\p{L}\p{N}_.]+/gu) || []).map(tag => tag.replace('@', '').toLowerCase())));
};

const getExpiryDate = () => {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + STORY_EXPIRY_HOURS);
  return expiresAt;
};

const isVideoFile = (file: Express.Multer.File) => {
  return file.mimetype?.startsWith('video');
};

const isImageFile = (file: Express.Multer.File) => {
  return file.mimetype?.startsWith('image');
};

const assertStoryFile = (file?: Express.Multer.File) => {
  if (!file) return 'Media required';
  const video = isVideoFile(file);
  const image = isImageFile(file);
  if (!video && !image) return 'Only image or video story media is allowed';
  if (image && file.size > STORY_MAX_IMAGE_SIZE) return 'Image story is too large';
  if (video && file.size > STORY_MAX_VIDEO_SIZE) return 'Video story is too large';
  return null;
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
  if (!story) return false;
  if (story.userId === viewerId) return true;
  if (story.archived) return false;
  if (story.moderationStatus !== 'approved') return false;
  if (story.expiresAt && new Date(story.expiresAt).getTime() <= Date.now() && !story.isHighlight) return false;
  if (Array.isArray(story.hideFrom) && story.hideFrom.includes(viewerId)) return false;

  if (story.visibility === 'private') return false;

  if (story.visibility === 'selected' || story.visibility === 'custom') {
    return Array.isArray(story.allowedUsers) && story.allowedUsers.includes(viewerId);
  }

  if (story.visibility === 'close_friends') {
    const cf = await prisma.closeFriendsList.findUnique({
      where: { ownerUserId: story.userId }
    });
    return !!cf?.memberUserIds?.includes(viewerId);
  }

  if (story.visibility === 'followers') {
    const viewer = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { following: true }
    });
    return !!viewer?.following?.includes(story.userId);
  }

  return true;
};

const ensureConversation = async (userA: string, userB: string) => {
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'direct',
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
      type: 'direct',
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

const calculateRetention = (story: any) => {
  const views = Number(story?.views || 0);
  const replies = Number(story?._count?.replies || 0);
  const reactions = Object.values((story?.reactions || {}) as Record<string, string[]>).reduce((sum, users: any) => sum + (Array.isArray(users) ? users.length : 0), 0);
  const linkClicks = Number(story?.linkClicks || 0);
  if (!views) return 0;
  return Math.min(1, Number(((replies * 0.35 + reactions * 0.25 + linkClicks * 0.4) / views).toFixed(4)));
};

export const createStory = async (req: Request, res: Response) => {
  try {
    const fileError = assertStoryFile(req.file);
    if (fileError) return res.status(400).json({ error: fileError });

    const userId = req.userId!;
    const file = req.file!;
    const video = isVideoFile(file);
    const caption = normalizeCaption(req.body.caption);
    const visibility = req.body.visibility || 'all';

    const allowedUsers = normalizeStringArray(req.body.allowedUsers);
    const hideFrom = normalizeStringArray(req.body.hideFrom);
    const hashtags = normalizeStringArray(req.body.hashtags);
    const mentions = normalizeStringArray(req.body.mentions);

    if (visibility === 'close_friends') {
      const cf = await prisma.closeFriendsList.findUnique({
        where: { ownerUserId: userId }
      });

      if (!cf?.memberUserIds?.length) {
        return res.status(400).json({ error: 'Close Friends list is empty' });
      }
    }

    if ((visibility === 'selected' || visibility === 'custom') && !allowedUsers.length) {
      return res.status(400).json({ error: 'Selected visibility requires allowed users' });
    }

    const moderation = await moderateContent({
      mediaUrl: (file as any).path || file.filename || file.originalname,
      videoUrl: video ? ((file as any).path || file.originalname) : undefined,
      text: caption,
      caption,
      userId
    } as any);

    if (moderation.flagged || moderation.status === 'rejected') {
      return res.status(400).json({
        error: 'Content violates community guidelines',
        reason: moderation.reason || 'moderation_failed'
      });
    }

    const uploadResult = await uploadToCloudinary(file, 'stories', {
      resource_type: video ? 'video' : 'image',
      transformation: [
        { quality: 'auto:good', fetch_format: 'auto' },
        ...(video ? [{ width: 1080, height: 1920, crop: 'limit', duration: STORY_VIDEO_DURATION }] : [{ width: 1080, height: 1920, crop: 'limit' }])
      ]
    });

    const thumbnailResult = video
      ? await generateThumbnails(uploadResult.secure_url, [0.1])
      : [uploadResult.secure_url];

    const duration = video
      ? parseNumber(req.body.duration, STORY_VIDEO_DURATION, 1, STORY_VIDEO_DURATION)
      : parseNumber(req.body.duration, STORY_IMAGE_DURATION, 1, 30);

    const story = await prisma.story.create({
      data: {
        userId,
        mediaUrl: uploadResult.secure_url,
        mediaType: video ? 'video' : 'image',
        duration,
        thumbnailUrl: Array.isArray(thumbnailResult) ? thumbnailResult[0] : thumbnailResult,
        caption,
        music: parseJson(req.body.music, null),
        stickers: parseJson(req.body.stickers, []),
        filters: parseJson(req.body.filters, {}),
        textOverlays: parseJson(req.body.textOverlays, []),
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
        hashtagStickers: hashtags.length ? hashtags : extractHashtagsFromText(caption),
        mentionStickers: mentions.length ? mentions : extractMentionsFromText(caption),
        isHighlight: parseBoolean(req.body.isHighlight, false),
        highlightName: parseBoolean(req.body.isHighlight, false) ? String(req.body.highlightName || '').trim() || null : null,
        highlightFolder: parseBoolean(req.body.isHighlight, false) ? String(req.body.highlightFolder || '').trim() || null : null,
        expiresAt: getExpiryDate(),
        moderationStatus: moderation.status === 'pending' ? 'pending' : 'approved',
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

    const followers = await prisma.user.findMany({
      where: { following: { has: userId } },
      select: { id: true }
    });

    followers.forEach(f => {
      if (!hideFrom.includes(f.id)) {
        io.to(`user:${f.id}`).emit('story:new', {
          storyId: story.id,
          author: story.author,
          thumbnailUrl: story.thumbnailUrl,
          mediaType: story.mediaType,
          createdAt: story.createdAt
        });
      }
    });

    io.to(`user:${userId}`).emit('story:created', story);

    await prisma.user.update({
      where: { id: userId },
      data: { xp: { increment: 5 } }
    });

    res.status(201).json(story);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to create story',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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
        expiresAt: { gt: new Date() },
        moderationStatus: 'approved',
        archived: false
      },
      include: getStorySelect(),
      orderBy: [
        { createdAt: 'desc' }
      ]
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

    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to load active stories',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const getUserStories = async (req: Request, res: Response) => {
  try {
    const viewerId = req.userId!;
    const { userId } = req.params;

    const stories = await prisma.story.findMany({
      where: {
        userId,
        expiresAt: { gt: new Date() },
        moderationStatus: 'approved',
        archived: false
      },
      include: getStorySelect(),
      orderBy: { createdAt: 'asc' }
    });

    const visible = [];

    for (const story of stories) {
      if (await canViewStory(story, viewerId)) {
        visible.push({
          ...story,
          viewed: Array.isArray(story.viewers) && story.viewers.includes(viewerId)
        });
      }
    }

    res.json(visible);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to load user stories',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const viewStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot view this story' });
    }

    if (Array.isArray(story.viewers) && story.viewers.includes(userId)) {
      return res.json({ alreadyViewed: true, totalViews: story.views });
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

    io.to(`user:${story.userId}`).emit('story:view', {
      storyId: id,
      viewerId: userId,
      totalViews: updated.views
    });

    res.json({ status: 'viewed', totalViews: updated.views });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to mark story as viewed',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const replyToStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const content = normalizeCaption(req.body.content);
    const mediaUrl = req.body.mediaUrl ? String(req.body.mediaUrl) : null;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'Reply content or media is required' });
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

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot reply to this story' });
    }

    if (!story.allowReplies) {
      return res.status(403).json({ error: 'Replies are disabled for this story' });
    }

    const moderation = await moderateContent({
      text: content,
      userId
    } as any);

    if (moderation.flagged || moderation.status === 'rejected') {
      return res.status(400).json({ error: 'Reply violates community guidelines' });
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
            avatarUrl: true,
            isVerified: true
          }
        }
      }
    });

    if (story.userId !== userId) {
      const conversation = await ensureConversation(userId, story.userId);

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          content: content ? `[Story Reply] ${content}` : '[Story Reply]',
          mediaUrl: mediaUrl || undefined,
          replyToMediaUrl: story.mediaUrl
        } as any
      });
    }

    io.to(`user:${story.userId}`).emit('story:reply', {
      storyId: id,
      reply
    });

    res.status(201).json(reply);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to reply to story',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const reactToStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const reaction = String(req.body.reaction || req.body.emoji || '').trim();

    if (!reaction) return res.status(400).json({ error: 'Reaction required' });

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot react to this story' });
    }

    if (!story.allowReactions) {
      return res.status(403).json({ error: 'Reactions are disabled for this story' });
    }

    const reactions = { ...((story.reactions as any) || {}) };

    Object.keys(reactions).forEach(key => {
      if (Array.isArray(reactions[key])) {
        reactions[key] = reactions[key].filter((id: string) => id !== userId);
      }
    });

    if (!Array.isArray(reactions[reaction])) reactions[reaction] = [];
    reactions[reaction].push(userId);

    const updated = await prisma.story.update({
      where: { id },
      data: { reactions },
      select: {
        id: true,
        userId: true,
        reactions: true
      }
    });

    io.to(`user:${story.userId}`).emit('story:reaction', {
      storyId: id,
      userId,
      reaction
    });

    res.json({ status: 'reacted', reactions: updated.reactions });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to react to story',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const removeStoryReaction = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });

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

    io.to(`user:${story.userId}`).emit('story:reaction_removed', {
      storyId: id,
      userId
    });

    res.json({ status: 'removed', reactions: updated.reactions });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to remove reaction',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot vote on this story' });
    }

    const poll = { ...((story.pollSticker as any) || {}) };

    if (!poll || !Array.isArray(poll.options)) {
      return res.status(400).json({ error: 'No poll available' });
    }

    if (optionIndex < 0 || optionIndex >= poll.options.length) {
      return res.status(400).json({ error: 'Invalid poll option' });
    }

    poll.options = poll.options.map((option: any) => ({
      ...option,
      votes: Array.isArray(option.votes) ? option.votes.filter((id: string) => id !== userId) : []
    }));

    poll.options[optionIndex].votes.push(userId);
    poll.totalVotes = poll.options.reduce((sum: number, option: any) => sum + (Array.isArray(option.votes) ? option.votes.length : 0), 0);

    const updated = await prisma.story.update({
      where: { id },
      data: { pollSticker: poll },
      select: { pollSticker: true, userId: true }
    });

    io.to(`story:${id}`).emit('poll:update', {
      storyId: id,
      optionIndex,
      total: poll.totalVotes,
      poll: updated.pollSticker
    });

    io.to(`user:${story.userId}`).emit('story:poll_vote', {
      storyId: id,
      voterId: userId,
      optionIndex,
      total: poll.totalVotes
    });

    res.json({ status: 'voted', total: poll.totalVotes, poll: updated.pollSticker });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to vote on poll',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const answerQuestionSticker = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;
    const answer = normalizeCaption(req.body.answer);

    if (!answer) return res.status(400).json({ error: 'Answer required' });

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot answer this story' });
    }

    const question = { ...((story.questionSticker as any) || {}) };

    if (!question) return res.status(400).json({ error: 'No question sticker available' });

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

    io.to(`user:${story.userId}`).emit('story:question_answer', {
      storyId: id,
      userId,
      answer
    });

    res.status(201).json({ status: 'answered', questionSticker: updated.questionSticker });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to answer question',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const trackStoryLinkClick = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });

    if (!(await canViewStory(story, userId))) {
      return res.status(403).json({ error: 'You cannot open this story link' });
    }

    const updated = await prisma.story.update({
      where: { id },
      data: { linkClicks: { increment: 1 } },
      select: { linkClicks: true, userId: true }
    });

    io.to(`user:${story.userId}`).emit('story:link_click', {
      storyId: id,
      userId,
      linkClicks: updated.linkClicks
    });

    res.json({ status: 'tracked', linkClicks: updated.linkClicks });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to track link click',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const createHighlight = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const name = String(req.body.name || '').trim();
    const storyIds = normalizeStringArray(req.body.storyIds);

    if (!name) return res.status(400).json({ error: 'Highlight name required' });
    if (!storyIds.length) return res.status(400).json({ error: 'Select at least one story' });

    const stories = await prisma.story.findMany({
      where: {
        id: { in: storyIds },
        userId
      },
      orderBy: { createdAt: 'asc' }
    });

    if (!stories.length) {
      return res.status(404).json({ error: 'No valid stories found' });
    }

    const cover = req.body.coverUrl || stories[0]?.thumbnailUrl || stories[0]?.mediaUrl;

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
        archived: true,
        archivedAt: new Date()
      }
    });

    io.to(`user:${userId}`).emit('story:highlight_created', highlight);

    res.status(201).json(highlight);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to create highlight',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const getHighlights = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const highlights = await prisma.storyHighlight.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.json(highlights);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to load highlights',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const deleteStory = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.userId!;

    const story = await prisma.story.findUnique({
      where: { id }
    });

    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (story.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    await prisma.story.update({
      where: { id },
      data: {
        archived: true,
        archivedAt: new Date()
      }
    });

    io.to(`user:${userId}`).emit('story:deleted', { storyId: id });

    res.json({ status: 'deleted' });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to delete story',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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

    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (story.userId !== userId) return res.status(403).json({ error: 'Access denied' });

    const viewers = await prisma.user.findMany({
      where: {
        id: { in: story.viewers || [] }
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        isVerified: true
      }
    });

    const order = new Map((story.viewers || []).map((id: string, index: number) => [id, index]));

    viewers.sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));

    res.json(viewers);
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to load story viewers',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
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

    if (!story) return res.status(404).json({ error: 'Not found' });

    const reactions = (story.reactions as any) || {};
    const reactionBreakdown = Object.keys(reactions).reduce((acc, key) => {
      acc[key] = Array.isArray(reactions[key]) ? reactions[key].length : 0;
      return acc;
    }, {} as Record<string, number>);

    const poll = story.pollSticker as any;
    const pollVotes = poll?.options?.reduce((sum: number, option: any) => sum + (Array.isArray(option.votes) ? option.votes.length : 0), 0) || 0;

    const question = story.questionSticker as any;
    const questionAnswers = Array.isArray(question?.answers) ? question.answers.length : 0;

    res.json({
      storyId: story.id,
      views: story.views,
      uniqueViewers: Array.isArray(story.viewers) ? story.viewers.length : 0,
      replies: story._count?.replies || 0,
      linkClicks: story.linkClicks || 0,
      pollVotes,
      questionAnswers,
      reactions: reactionBreakdown,
      viewers: story.viewers,
      retention: calculateRetention(story),
      createdAt: story.createdAt,
      expiresAt: story.expiresAt
    });
  } catch (err: any) {
    res.status(500).json({
      error: 'Failed to load story analytics',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const expireStories = async () => {
  const expired = await prisma.story.findMany({
    where: {
      expiresAt: { lt: new Date() },
      archived: false
    }
  });

  for (const story of expired) {
    if (story.isHighlight) {
      await prisma.story.update({
        where: { id: story.id },
        data: {
          archived: true,
          archivedAt: new Date()
        }
      });
    } else {
      await prisma.story.update({
        where: { id: story.id },
        data: {
          archived: true,
          archivedAt: new Date()
        }
      });
    }

    io.to(`user:${story.userId}`).emit('story:expired', {
      storyId: story.id
    });
  }

  return {
    expired: expired.length
  };
};
