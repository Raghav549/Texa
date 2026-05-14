import axios from 'axios';
import crypto from 'crypto';
import { ModerationStatus as PrismaModerationStatus, ProductStatus, RoomStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { redis } from '../../config/redis';

export enum ModerationStatus {
  SAFE = 'SAFE',
  REVIEW = 'REVIEW',
  BLOCKED = 'BLOCKED'
}

export type ModerationType = 'image' | 'video' | 'text' | 'user' | 'message' | 'comment' | 'reel' | 'story' | 'product' | 'room';

export type ModerationAction = 'approve' | 'review' | 'block' | 'delete';

export interface ModerationPayload {
  type: ModerationType;
  content: string;
  userId: string;
  itemId?: string;
  metadata?: Record<string, any>;
}

export interface ModerationResult {
  status: ModerationStatus;
  flags: string[];
  score: number;
  queued?: boolean;
  provider?: string;
  reportId?: string | null;
}

const PERSPECTIVE_URL = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';

const BLOCKED_WORDS = [
  'kill yourself',
  'terrorist threat',
  'child abuse',
  'rape threat',
  'bomb threat',
  'school shooting',
  'acid attack',
  'suicide bait'
];

const REVIEW_WORDS = [
  'scam',
  'fraud',
  'hate',
  'abuse',
  'harass',
  'threat',
  'nude',
  'nsfw',
  'violence',
  'weapon',
  'blood',
  'fake',
  'spam',
  'illegal',
  'drugs',
  'self harm'
];

const normalize = (value: string) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s:/._-]/gu, '')
    .trim();

const hashContent = (content: string) => crypto.createHash('sha256').update(String(content || '')).digest('hex');

const clampScore = (score: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(score) ? score : 0)));

const uniq = <T>(items: T[]) => [...new Set(items.filter(Boolean))];

const safeLimit = (value: number, min = 1, max = 200) => Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value) : min));

const toPrismaStatus = (status: ModerationStatus): PrismaModerationStatus => {
  if (status === ModerationStatus.BLOCKED) return PrismaModerationStatus.BLOCKED;
  if (status === ModerationStatus.REVIEW) return PrismaModerationStatus.REVIEW;
  return PrismaModerationStatus.SAFE;
};

const fromPrismaStatus = (status: unknown): ModerationStatus => {
  if (status === PrismaModerationStatus.BLOCKED || status === 'BLOCKED') return ModerationStatus.BLOCKED;
  if (status === PrismaModerationStatus.REVIEW || status === 'REVIEW') return ModerationStatus.REVIEW;
  return ModerationStatus.SAFE;
};

const getQueueKey = (payload: ModerationPayload) =>
  `moderation:lock:${payload.userId}:${payload.itemId || hashContent(payload.content).slice(0, 24)}`;

const getCacheKey = (payload: ModerationPayload) =>
  `moderation:cache:${payload.type}:${hashContent(`${payload.content}:${JSON.stringify(payload.metadata || {})}`)}`;

const safeJson = (value: any) => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const parseJson = <T>(value: string | null): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const keywordScan = (content: string) => {
  const text = normalize(content);
  const flags: string[] = [];
  let score = 0;

  for (const word of BLOCKED_WORDS) {
    if (text.includes(normalize(word))) {
      flags.push('blocked_keyword');
      score += 90;
      break;
    }
  }

  for (const word of REVIEW_WORDS) {
    if (text.includes(normalize(word))) {
      flags.push(`keyword_${word.replace(/\s+/g, '_')}`);
      score += 18;
    }
  }

  if (/(.)\1{8,}/u.test(text)) {
    flags.push('spam_pattern');
    score += 12;
  }

  const linkCount = (content.match(/https?:\/\/|www\./gi) || []).length;
  if (linkCount >= 4) {
    flags.push('link_spam');
    score += 25;
  }

  const mentionCount = (content.match(/@\w+/g) || []).length;
  if (mentionCount >= 8) {
    flags.push('mention_spam');
    score += 20;
  }

  const hashtagCount = (content.match(/#\w+/g) || []).length;
  if (hashtagCount >= 15) {
    flags.push('hashtag_spam');
    score += 15;
  }

  const phoneLike = (content.match(/\b(?:\+?\d[\s-]?){9,14}\b/g) || []).length;
  if (phoneLike >= 3) {
    flags.push('phone_spam');
    score += 18;
  }

  const repeatedLinks = new Set(content.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) || []);
  if (linkCount >= 2 && repeatedLinks.size === 1) {
    flags.push('repeated_link');
    score += 15;
  }

  return {
    score: clampScore(score),
    flags: uniq(flags)
  };
};

const perspectiveScan = async (content: string) => {
  if (!process.env.GOOGLE_PERSPECTIVE_API_KEY) {
    return { score: 0, flags: [] as string[], provider: 'local' };
  }

  try {
    const { data } = await axios.post(
      PERSPECTIVE_URL,
      {
        comment: { text: content, type: 'PLAIN_TEXT' },
        languages: ['en'],
        requestedAttributes: {
          TOXICITY: {},
          SEVERE_TOXICITY: {},
          INSULT: {},
          PROFANITY: {},
          THREAT: {},
          IDENTITY_ATTACK: {},
          SEXUALLY_EXPLICIT: {}
        }
      },
      {
        params: { key: process.env.GOOGLE_PERSPECTIVE_API_KEY },
        timeout: Number(process.env.MODERATION_API_TIMEOUT_MS || 7000)
      }
    );

    const scores = data?.attributeScores || {};
    const toxicity = Number(scores.TOXICITY?.summaryScore?.value || 0);
    const severeToxicity = Number(scores.SEVERE_TOXICITY?.summaryScore?.value || 0);
    const insult = Number(scores.INSULT?.summaryScore?.value || 0);
    const profanity = Number(scores.PROFANITY?.summaryScore?.value || 0);
    const threat = Number(scores.THREAT?.summaryScore?.value || 0);
    const identityAttack = Number(scores.IDENTITY_ATTACK?.summaryScore?.value || 0);
    const sexuallyExplicit = Number(scores.SEXUALLY_EXPLICIT?.summaryScore?.value || 0);

    const flags: string[] = [];
    let score = 0;

    if (toxicity >= 0.8) {
      flags.push('toxicity');
      score += 45;
    } else if (toxicity >= 0.55) {
      flags.push('mild_toxicity');
      score += 25;
    }

    if (severeToxicity >= 0.65) {
      flags.push('severe_toxicity');
      score += 55;
    }

    if (insult >= 0.7) {
      flags.push('insult');
      score += 25;
    }

    if (profanity >= 0.75) {
      flags.push('profanity');
      score += 20;
    }

    if (threat >= 0.55) {
      flags.push('threat');
      score += 60;
    }

    if (identityAttack >= 0.55) {
      flags.push('identity_attack');
      score += 45;
    }

    if (sexuallyExplicit >= 0.65) {
      flags.push('sexually_explicit');
      score += 40;
    }

    return {
      score: clampScore(score),
      flags: uniq(flags),
      provider: 'perspective'
    };
  } catch {
    return { score: 0, flags: ['moderation_provider_unavailable'], provider: 'local_fallback' };
  }
};

const mediaScan = async (payload: ModerationPayload) => {
  const flags: string[] = [];
  let score = 0;
  const content = payload.content || '';
  const lower = content.toLowerCase();

  const isRemote = /^https?:\/\//i.test(content);
  const isLocal = /^\/?uploads\//i.test(content) || /^[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp|mp4|webm|mov)$/i.test(content);

  if (!isRemote && !isLocal) {
    flags.push('invalid_media_reference');
    score += 35;
  }

  if (lower.includes('nsfw') || lower.includes('adult') || lower.includes('nude')) {
    flags.push('possible_nsfw_media');
    score += 55;
  }

  if (lower.includes('violence') || lower.includes('blood') || lower.includes('weapon')) {
    flags.push('possible_violent_media');
    score += 45;
  }

  const duration = Number(payload.metadata?.duration || 0);
  const size = Number(payload.metadata?.size || 0);
  const width = Number(payload.metadata?.width || 0);
  const height = Number(payload.metadata?.height || 0);

  if (payload.type === 'video' || payload.type === 'reel') {
    if (duration > Number(process.env.MAX_MODERATION_VIDEO_DURATION_SECONDS || 300)) {
      flags.push('video_duration_too_long');
      score += 25;
    }

    if (duration > 0 && duration < 1) {
      flags.push('suspicious_video_duration');
      score += 10;
    }
  }

  if (size > Number(process.env.MAX_MODERATION_MEDIA_SIZE_BYTES || 250 * 1024 * 1024)) {
    flags.push('media_size_too_large');
    score += 20;
  }

  if ((width > 0 && width < 64) || (height > 0 && height < 64)) {
    flags.push('suspicious_media_resolution');
    score += 10;
  }

  if (process.env.AWS_REKOGNITION_ENABLED === 'true') {
    flags.push('external_media_scan_pending');
    score += 15;
  }

  return {
    score: clampScore(score),
    flags: uniq(flags),
    provider: process.env.AWS_REKOGNITION_ENABLED === 'true' ? 'rekognition_pending' : 'local_media'
  };
};

const userScan = async (payload: ModerationPayload) => {
  const text = `${payload.content || ''} ${safeJson(payload.metadata)}`;
  const keyword = keywordScan(text);
  const perspective = await perspectiveScan(text);

  return {
    score: clampScore(keyword.score + perspective.score),
    flags: uniq([...keyword.flags, ...perspective.flags]),
    provider: perspective.provider || 'local'
  };
};

const statusFromScore = (score: number, flags: string[]) => {
  if (flags.includes('blocked_keyword')) return ModerationStatus.BLOCKED;
  if (flags.includes('threat')) return ModerationStatus.BLOCKED;
  if (flags.includes('severe_toxicity')) return ModerationStatus.BLOCKED;
  if (score >= Number(process.env.MODERATION_BLOCK_SCORE || 80)) return ModerationStatus.BLOCKED;
  if (score >= Number(process.env.MODERATION_REVIEW_SCORE || 40)) return ModerationStatus.REVIEW;
  return ModerationStatus.SAFE;
};

const createReport = async (payload: ModerationPayload, result: Omit<ModerationResult, 'reportId'>) => {
  const report = await prisma.moderationReport.create({
    data: {
      userId: payload.userId,
      itemId: payload.itemId || null,
      type: payload.type,
      content: payload.content,
      status: toPrismaStatus(result.status),
      flags: result.flags.join(','),
      aiScore: result.score,
      metadata: {
        provider: result.provider || 'unknown',
        payloadMetadata: payload.metadata || {},
        contentHash: hashContent(payload.content)
      }
    } as any
  });

  return report.id;
};

const applyModerationToItem = async (payload: ModerationPayload, status: ModerationStatus, flags: string[]) => {
  if (!payload.itemId) return;

  const prismaStatus = toPrismaStatus(status);
  const flaggedReason = flags.join(',');

  if (payload.type === 'comment' || payload.type === 'text') {
    await prisma.comment.update({
      where: { id: payload.itemId },
      data: {
        moderationStatus: prismaStatus
      } as any
    }).catch(() => null);
  }

  if (payload.type === 'message') {
    if (status === ModerationStatus.BLOCKED) {
      await prisma.message.update({
        where: { id: payload.itemId },
        data: {
          deletedAt: new Date()
        } as any
      }).catch(() => null);
    }
  }

  if (payload.type === 'reel' || payload.type === 'video') {
    await prisma.reel.update({
      where: { id: payload.itemId },
      data: {
        moderationStatus: prismaStatus,
        flaggedReason: status === ModerationStatus.SAFE ? null : flaggedReason,
        isDraft: status === ModerationStatus.BLOCKED ? true : undefined
      } as any
    }).catch(() => null);
  }

  if (payload.type === 'story' || payload.type === 'image') {
    await prisma.story.update({
      where: { id: payload.itemId },
      data: {
        flagged: status !== ModerationStatus.SAFE
      } as any
    }).catch(() => null);
  }

  if (payload.type === 'product') {
    await prisma.product.update({
      where: { id: payload.itemId },
      data: {
        status: status === ModerationStatus.BLOCKED ? ProductStatus.REJECTED : undefined
      } as any
    }).catch(() => null);
  }

  if (payload.type === 'room') {
    await prisma.voiceRoom.update({
      where: { id: payload.itemId },
      data: {
        status: status === ModerationStatus.BLOCKED ? RoomStatus.CLOSED : undefined,
        isActive: status === ModerationStatus.BLOCKED ? false : undefined
      } as any
    }).catch(() => null);
  }
};

export async function moderateContent(payload: ModerationPayload): Promise<ModerationResult> {
  if (!payload?.userId) throw new Error('userId is required');
  if (!payload?.type) throw new Error('type is required');

  if (!payload?.content?.trim()) {
    return {
      status: ModerationStatus.SAFE,
      flags: [],
      score: 0,
      provider: 'empty',
      reportId: null
    };
  }

  const cacheKey = getCacheKey(payload);
  const cached = parseJson<ModerationResult>(await redis.get(cacheKey));

  if (cached) return cached;

  const queueKey = getQueueKey(payload);
  const locked = await redis.set(queueKey, 'processing', 'EX', 300, 'NX');

  if (!locked) {
    return {
      status: ModerationStatus.REVIEW,
      flags: ['already_processing'],
      score: 40,
      queued: true,
      provider: 'lock',
      reportId: null
    };
  }

  try {
    let scan: { score: number; flags: string[]; provider?: string };

    if (payload.type === 'text' || payload.type === 'comment' || payload.type === 'message') {
      const keyword = keywordScan(payload.content);
      const perspective = await perspectiveScan(payload.content);
      scan = {
        score: clampScore(keyword.score + perspective.score),
        flags: uniq([...keyword.flags, ...perspective.flags]),
        provider: perspective.provider || 'local'
      };
    } else if (payload.type === 'image' || payload.type === 'video' || payload.type === 'reel' || payload.type === 'story' || payload.type === 'product') {
      const keyword = keywordScan(`${payload.content} ${safeJson(payload.metadata)}`);
      const media = await mediaScan(payload);
      scan = {
        score: clampScore(keyword.score + media.score),
        flags: uniq([...keyword.flags, ...media.flags]),
        provider: media.provider || 'local_media'
      };
    } else {
      scan = await userScan(payload);
    }

    const status = statusFromScore(scan.score, scan.flags);

    const result: ModerationResult = {
      status,
      flags: scan.flags,
      score: scan.score,
      provider: scan.provider || 'local',
      reportId: null
    };

    if (status !== ModerationStatus.SAFE) {
      result.reportId = await createReport(payload, result);
    }

    await applyModerationToItem(payload, status, scan.flags);

    await redis.set(cacheKey, JSON.stringify(result), 'EX', Number(process.env.MODERATION_CACHE_TTL_SECONDS || 3600));

    return result;
  } finally {
    await redis.del(queueKey);
  }
}

export async function getModerationQueue(status?: string, limit = 100, cursor?: string) {
  const normalizedStatus =
    status === ModerationStatus.SAFE || status === ModerationStatus.REVIEW || status === ModerationStatus.BLOCKED
      ? toPrismaStatus(status)
      : undefined;

  return prisma.moderationReport.findMany({
    where: normalizedStatus ? { status: normalizedStatus } : {},
    include: {
      user: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: safeLimit(Number(limit) || 100, 1, 200),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
  });
}

export async function resolveModeration(id: string, action: ModerationAction, moderatorId?: string) {
  const report = await prisma.moderationReport.findUnique({ where: { id } });
  if (!report) throw new Error('Report not found');

  const newStatus =
    action === 'approve'
      ? ModerationStatus.SAFE
      : action === 'review'
        ? ModerationStatus.REVIEW
        : ModerationStatus.BLOCKED;

  const updated = await prisma.moderationReport.update({
    where: { id },
    data: {
      status: toPrismaStatus(newStatus),
      resolvedAt: new Date(),
      resolvedBy: moderatorId || null,
      resolutionAction: action
    } as any
  });

  if ((action === 'block' || action === 'delete') && report.userId) {
    await prisma.user.update({
      where: { id: report.userId },
      data: {
        moderationStrikes: { increment: 1 }
      } as any
    }).catch(() => null);
  }

  if (action === 'approve' && report.itemId) {
    await applyModerationToItem(
      {
        type: report.type as ModerationType,
        content: report.content || '',
        userId: report.userId,
        itemId: report.itemId,
        metadata: {}
      },
      ModerationStatus.SAFE,
      []
    );
  }

  if ((action === 'block' || action === 'delete') && report.itemId) {
    await applyModerationToItem(
      {
        type: report.type as ModerationType,
        content: report.content || '',
        userId: report.userId,
        itemId: report.itemId,
        metadata: {}
      },
      ModerationStatus.BLOCKED,
      String(report.flags || '').split(',').filter(Boolean)
    );
  }

  await redis.del(`moderation:report:${id}`);

  return {
    success: true,
    status: fromPrismaStatus(updated.status),
    action
  };
}

export async function createManualModerationReport(input: {
  userId: string;
  reporterId?: string;
  itemId?: string;
  type: ModerationType;
  content: string;
  reason: string;
  metadata?: Record<string, any>;
}) {
  const report = await prisma.moderationReport.create({
    data: {
      userId: input.userId,
      itemId: input.itemId || null,
      type: input.type,
      content: input.content,
      status: PrismaModerationStatus.REVIEW,
      flags: input.reason,
      aiScore: 40,
      metadata: {
        reporterId: input.reporterId || null,
        reason: input.reason,
        ...input.metadata
      }
    } as any
  });

  return report;
}

export async function getUserModerationRisk(userId: string) {
  const [reports, blocked, review] = await Promise.all([
    prisma.moderationReport.count({ where: { userId } }),
    prisma.moderationReport.count({ where: { userId, status: PrismaModerationStatus.BLOCKED } }),
    prisma.moderationReport.count({ where: { userId, status: PrismaModerationStatus.REVIEW } })
  ]);

  const score = clampScore(blocked * 30 + review * 12 + reports * 4);

  return {
    userId,
    reports,
    blocked,
    review,
    riskScore: score,
    riskLevel: score >= 80 ? 'high' : score >= 40 ? 'medium' : 'low'
  };
}

export async function clearModerationCache(content: string, type: ModerationType) {
  const pattern = `moderation:cache:${type}:${hashContent(content)}*`;
  const keys: string[] = [];
  const stream = redis.scanStream({ match: pattern, count: 100 });

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (items: string[]) => {
      keys.push(...items);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (keys.length) await redis.del(...keys);

  return { success: true, deleted: keys.length };
}

export async function clearModerationReportCache(id: string) {
  await redis.del(`moderation:report:${id}`);
  return { success: true };
}
