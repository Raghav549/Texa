import axios from 'axios';
import crypto from 'crypto';
import net from 'net';
import { prisma } from '../config/db';
import { ModerationStatus } from '@prisma/client';

export interface ModerationInput {
  videoUrl?: string;
  imageUrl?: string;
  text?: string;
  userId: string;
  contentId?: string;
  contentType?: 'reel' | 'comment' | 'message' | 'profile' | 'post' | 'story';
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface ModerationResult {
  status: 'approved' | 'rejected' | 'pending';
  flagged: boolean;
  reason?: string;
  ageRestricted: boolean;
  confidence: number;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  signals: ModerationSignal[];
  action: 'allow' | 'limit' | 'shadow_limit' | 'manual_review' | 'remove';
  reviewRequired: boolean;
  fingerprint?: string;
}

interface ModerationSignal {
  type:
    | 'text'
    | 'url'
    | 'spam'
    | 'toxicity'
    | 'adult'
    | 'violence'
    | 'self_harm'
    | 'harassment'
    | 'hate'
    | 'scam'
    | 'illegal'
    | 'impersonation'
    | 'video'
    | 'image'
    | 'user_history'
    | 'rate_abuse'
    | 'pii'
    | 'malware'
    | 'copyright'
    | 'unknown';
  reason: string;
  score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  matched?: string;
}

type TextRule = {
  type: ModerationSignal['type'];
  reason: string;
  severity: ModerationSignal['severity'];
  score: number;
  patterns: RegExp[];
  ageRestricted?: boolean;
  reject?: boolean;
};

const TEXT_RULES: TextRule[] = [
  {
    type: 'hate',
    reason: 'hate_or_dehumanizing_content',
    severity: 'critical',
    score: 0.98,
    reject: true,
    patterns: [
      /\b(hate\s*speech|racial\s*slur|kill\s+all|exterminate\s+all|gas\s+all|dehumanize)\b/i
    ]
  },
  {
    type: 'violence',
    reason: 'violent_threat_or_instruction',
    severity: 'critical',
    score: 0.97,
    reject: true,
    patterns: [
      /\b(i\s*will\s*kill\s*you|murder\s*you|shoot\s*you|stab\s*you|bomb\s*threat|burn\s*you\s*alive)\b/i,
      /\b(how\s*to\s*make\s*a\s*bomb|make\s*explosive|build\s*explosive|pressure\s*cooker\s*bomb)\b/i
    ]
  },
  {
    type: 'self_harm',
    reason: 'self_harm_or_suicide_content',
    severity: 'high',
    score: 0.92,
    reject: false,
    patterns: [
      /\b(suicide|self\s*harm|kill\s*myself|end\s*my\s*life|cut\s*myself|i\s*want\s*to\s*die)\b/i
    ]
  },
  {
    type: 'adult',
    reason: 'adult_or_explicit_content',
    severity: 'high',
    score: 0.9,
    ageRestricted: true,
    reject: false,
    patterns: [
      /\b(explicit\s*content|porn|nude|nudity|xxx|adult\s*video|sexually\s*explicit|onlyfans|nsfw)\b/i
    ]
  },
  {
    type: 'harassment',
    reason: 'harassment_or_bullying',
    severity: 'medium',
    score: 0.82,
    reject: false,
    patterns: [
      /\b(go\s*die|worthless|ugly\s*trash|stupid\s*idiot|publicly\s*shame|you\s*are\s*trash)\b/i
    ]
  },
  {
    type: 'scam',
    reason: 'scam_or_financial_fraud',
    severity: 'high',
    score: 0.91,
    reject: false,
    patterns: [
      /\b(guaranteed\s*profit|double\s*your\s*money|free\s*crypto|send\s*otp|share\s*password|bank\s*otp|upi\s*pin|card\s*cvv)\b/i,
      /\b(telegram\s*investment|whatsapp\s*earning|risk\s*free\s*trading|fixed\s*match|sure\s*shot\s*earning)\b/i
    ]
  },
  {
    type: 'illegal',
    reason: 'illegal_goods_or_services',
    severity: 'high',
    score: 0.93,
    reject: false,
    patterns: [
      /\b(buy\s*drugs|sell\s*drugs|fake\s*passport|fake\s*id|stolen\s*card|carding|cvv|dumps|fullz)\b/i
    ]
  },
  {
    type: 'spam',
    reason: 'spam_or_engagement_manipulation',
    severity: 'medium',
    score: 0.76,
    reject: false,
    patterns: [
      /\b(follow\s*for\s*follow|like\s*for\s*like|1000\s*followers|free\s*followers|bot\s*followers|sub\s*for\s*sub)\b/i
    ]
  },
  {
    type: 'impersonation',
    reason: 'impersonation_or_fake_identity',
    severity: 'medium',
    score: 0.72,
    reject: false,
    patterns: [
      /\b(official\s*support|admin\s*team|verified\s*staff|customer\s*care\s*agent)\b/i
    ]
  },
  {
    type: 'malware',
    reason: 'malware_or_credential_theft',
    severity: 'high',
    score: 0.9,
    reject: false,
    patterns: [
      /\b(download\s*this\s*apk|mod\s*apk|hack\s*tool|password\s*stealer|session\s*cookie|token\s*grabber)\b/i
    ]
  }
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?:\+?\d[\s-]?){10,15}/g;
const SUSPICIOUS_TLDS = new Set(['zip', 'mov', 'click', 'work', 'rest', 'cam', 'country', 'gq', 'tk', 'ml', 'cf']);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'ow.ly', 'rb.gy']);

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();

const hashContent = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

const toPrismaModerationStatus = (status: ModerationResult['status']) => {
  const values = Object.values(ModerationStatus) as string[];
  const upper = status.toUpperCase();
  if (values.includes(upper)) return upper as ModerationStatus;
  if (status === 'approved' && values.includes('APPROVED')) return 'APPROVED' as ModerationStatus;
  if (status === 'rejected' && values.includes('REJECTED')) return 'REJECTED' as ModerationStatus;
  if (status === 'pending' && values.includes('PENDING')) return 'PENDING' as ModerationStatus;
  return values[0] as ModerationStatus;
};

const maxSeverity = (signals: ModerationSignal[]): ModerationResult['severity'] => {
  const order: ModerationResult['severity'][] = ['none', 'low', 'medium', 'high', 'critical'];
  return signals.reduce<ModerationResult['severity']>((highest, signal) => {
    return order.indexOf(signal.severity) > order.indexOf(highest) ? signal.severity : highest;
  }, 'none');
};

const scoreToStatus = (
  score: number,
  severity: ModerationResult['severity'],
  hasRejectSignal: boolean,
  ageRestricted: boolean
): Pick<ModerationResult, 'status' | 'action' | 'reviewRequired' | 'flagged'> => {
  if (hasRejectSignal || severity === 'critical' || score >= 0.94) {
    return { status: 'rejected', action: 'remove', reviewRequired: false, flagged: true };
  }

  if (severity === 'high' || score >= 0.78) {
    return { status: 'pending', action: 'manual_review', reviewRequired: true, flagged: true };
  }

  if (severity === 'medium' || score >= 0.58) {
    return {
      status: ageRestricted ? 'approved' : 'pending',
      action: ageRestricted ? 'limit' : 'shadow_limit',
      reviewRequired: !ageRestricted,
      flagged: true
    };
  }

  if (severity === 'low' || score >= 0.35) {
    return { status: 'approved', action: 'limit', reviewRequired: false, flagged: true };
  }

  return { status: 'approved', action: 'allow', reviewRequired: false, flagged: false };
};

const safeJsonValue = (value: any) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

export async function moderateContent(input: ModerationInput): Promise<ModerationResult> {
  if (!input?.userId) throw new Error('userId is required');

  const signals: ModerationSignal[] = [];
  const normalizedText = input.text ? normalizeText(input.text) : '';
  const fingerprint = hashContent(JSON.stringify({
    userId: input.userId,
    contentType: input.contentType || 'unknown',
    contentId: input.contentId || null,
    text: normalizedText || null,
    videoUrl: input.videoUrl || null,
    imageUrl: input.imageUrl || null
  }));

  if (normalizedText) {
    signals.push(...checkTextModeration(normalizedText));
    signals.push(...checkUrlModeration(normalizedText));
    signals.push(...checkSpamHeuristics(normalizedText));
    signals.push(...checkPiiHeuristics(normalizedText));
  }

  if (input.imageUrl) {
    signals.push(...await analyzeImageContent(input.imageUrl));
  }

  if (input.videoUrl) {
    signals.push(...await analyzeVideoContent(input.videoUrl));
  }

  signals.push(...await checkUserRisk(input.userId));
  signals.push(...await checkRateAbuse(input.userId, input.contentType));

  const sortedSignals = signals.sort((a, b) => b.score - a.score);
  const severity = maxSeverity(sortedSignals);
  const confidence = clamp(sortedSignals.length ? Math.max(...sortedSignals.map((s) => s.score)) : 0.01);
  const ageRestricted = sortedSignals.some((s) => s.type === 'adult') || sortedSignals.some((s) => s.reason.includes('age_restricted'));
  const hasRejectSignal = sortedSignals.some((s) => s.severity === 'critical' || s.reason.includes('violent_threat') || s.reason.includes('hate_or_dehumanizing'));
  const decision = scoreToStatus(confidence, severity, hasRejectSignal, ageRestricted);
  const reason = sortedSignals.length ? sortedSignals[0]?.reason : undefined;

  const result: ModerationResult = {
    status: decision.status,
    flagged: decision.flagged,
    reason,
    ageRestricted,
    confidence,
    severity,
    signals: sortedSignals,
    action: decision.action,
    reviewRequired: decision.reviewRequired,
    fingerprint
  };

  await persistModerationLog(input, result).catch(() => undefined);
  await applyModerationDecision(input, result).catch(() => undefined);

  return result;
}

export async function moderateText(text: string, userId: string, contentType: ModerationInput['contentType'] = 'post', metadata: Record<string, unknown> = {}) {
  return moderateContent({ text, userId, contentType, metadata });
}

export async function moderateReel(input: Omit<ModerationInput, 'contentType'>) {
  return moderateContent({ ...input, contentType: 'reel' });
}

export async function moderateComment(input: Omit<ModerationInput, 'contentType'>) {
  return moderateContent({ ...input, contentType: 'comment' });
}

export async function moderateMessage(input: Omit<ModerationInput, 'contentType'>) {
  return moderateContent({ ...input, contentType: 'message' });
}

export async function moderateStory(input: Omit<ModerationInput, 'contentType'>) {
  return moderateContent({ ...input, contentType: 'story' });
}

function checkTextModeration(text: string): ModerationSignal[] {
  const signals: ModerationSignal[] = [];

  for (const rule of TEXT_RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match?.[0]) {
        signals.push({
          type: rule.type,
          reason: rule.reason,
          score: rule.score,
          severity: rule.severity,
          matched: match[0].slice(0, 120)
        });
        break;
      }
    }
  }

  const capsRatio = text.length ? (text.replace(/[^A-Z]/g, '').length / text.length) : 0;
  if (text.length > 80 && capsRatio > 0.72) {
    signals.push({
      type: 'spam',
      reason: 'excessive_caps_spam_pattern',
      score: 0.52,
      severity: 'low'
    });
  }

  if (/(.)\1{8,}/i.test(text)) {
    signals.push({
      type: 'spam',
      reason: 'repeated_character_spam_pattern',
      score: 0.48,
      severity: 'low'
    });
  }

  if (text.length > 5000) {
    signals.push({
      type: 'spam',
      reason: 'oversized_text_payload',
      score: 0.57,
      severity: 'medium'
    });
  }

  return signals;
}

function checkUrlModeration(text: string): ModerationSignal[] {
  const urls = text.match(URL_PATTERN) || [];
  const signals: ModerationSignal[] = [];

  if (urls.length >= 5) {
    signals.push({
      type: 'url',
      reason: 'too_many_links',
      score: 0.7,
      severity: 'medium'
    });
  }

  for (const rawUrl of urls.slice(0, 10)) {
    try {
      const parsed = new URL(rawUrl);
      const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const tld = hostname.split('.').pop() || '';

      if (!['https:', 'http:'].includes(parsed.protocol)) {
        signals.push({
          type: 'url',
          reason: 'unsupported_url_protocol',
          score: 0.66,
          severity: 'medium',
          matched: rawUrl.slice(0, 120)
        });
      }

      if (SHORTENERS.has(hostname)) {
        signals.push({
          type: 'url',
          reason: 'shortened_url_review_required',
          score: 0.62,
          severity: 'medium',
          matched: hostname
        });
      }

      if (SUSPICIOUS_TLDS.has(tld)) {
        signals.push({
          type: 'url',
          reason: 'suspicious_url_tld',
          score: 0.58,
          severity: 'medium',
          matched: hostname
        });
      }

      if (/(login|verify|wallet|airdrop|bonus|free|claim|gift|otp|password|seed|private-key|kyc)/i.test(parsed.href)) {
        signals.push({
          type: 'scam',
          reason: 'phishing_like_url_pattern',
          score: 0.78,
          severity: 'high',
          matched: hostname
        });
      }

      if (!isSafeRemoteUrl(rawUrl, true)) {
        signals.push({
          type: 'url',
          reason: 'unsafe_or_private_url',
          score: 0.74,
          severity: 'medium',
          matched: hostname
        });
      }
    } catch {
      signals.push({
        type: 'url',
        reason: 'malformed_url',
        score: 0.4,
        severity: 'low',
        matched: rawUrl.slice(0, 80)
      });
    }
  }

  return signals;
}

function checkSpamHeuristics(text: string): ModerationSignal[] {
  const signals: ModerationSignal[] = [];
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words);
  const duplicateRatio = words.length ? 1 - uniqueWords.size / words.length : 0;
  const emojiCount = Array.from(text.matchAll(/\p{Extended_Pictographic}/gu)).length;
  const urlCount = (text.match(URL_PATTERN) || []).length;

  if (words.length >= 25 && duplicateRatio > 0.55) {
    signals.push({
      type: 'spam',
      reason: 'duplicate_word_spam',
      score: 0.68,
      severity: 'medium'
    });
  }

  if (emojiCount >= 25) {
    signals.push({
      type: 'spam',
      reason: 'emoji_spam',
      score: 0.54,
      severity: 'low'
    });
  }

  if (/(.)\1{12,}/.test(text.replace(/\s/g, ''))) {
    signals.push({
      type: 'spam',
      reason: 'flood_pattern',
      score: 0.61,
      severity: 'medium'
    });
  }

  if (urlCount >= 3 && words.length < 12) {
    signals.push({
      type: 'spam',
      reason: 'link_drop_spam',
      score: 0.69,
      severity: 'medium'
    });
  }

  return signals;
}

function checkPiiHeuristics(text: string): ModerationSignal[] {
  const signals: ModerationSignal[] = [];
  const emails = text.match(EMAIL_PATTERN) || [];
  const phones = text.match(PHONE_PATTERN) || [];

  if (emails.length >= 3) {
    signals.push({
      type: 'pii',
      reason: 'bulk_email_exposure',
      score: 0.62,
      severity: 'medium'
    });
  }

  if (phones.length >= 3) {
    signals.push({
      type: 'pii',
      reason: 'bulk_phone_exposure',
      score: 0.64,
      severity: 'medium'
    });
  }

  if (/\b(aadhaar|pan\s*card|passport\s*number|bank\s*account|ifsc|upi\s*pin)\b/i.test(text)) {
    signals.push({
      type: 'pii',
      reason: 'sensitive_identity_or_financial_data',
      score: 0.76,
      severity: 'high'
    });
  }

  return signals;
}

async function analyzeImageContent(imageUrl: string): Promise<ModerationSignal[]> {
  const signals: ModerationSignal[] = [];

  if (!isSafeRemoteUrl(imageUrl)) {
    return [{
      type: 'image',
      reason: 'unsafe_image_url',
      score: 0.74,
      severity: 'medium',
      matched: imageUrl.slice(0, 120)
    }];
  }

  const external = await callExternalModerationProvider('image', imageUrl).catch(() => null);
  if (external?.signals?.length) signals.push(...external.signals);

  return signals;
}

async function analyzeVideoContent(videoUrl: string): Promise<ModerationSignal[]> {
  const signals: ModerationSignal[] = [];

  if (!isSafeRemoteUrl(videoUrl)) {
    return [{
      type: 'video',
      reason: 'unsafe_video_url',
      score: 0.74,
      severity: 'medium',
      matched: videoUrl.slice(0, 120)
    }];
  }

  const external = await callExternalModerationProvider('video', videoUrl).catch(() => null);
  if (external?.signals?.length) signals.push(...external.signals);

  return signals;
}

function isPrivateIp(hostname: string) {
  if (net.isIP(hostname) === 0) return false;

  if (net.isIP(hostname) === 6) {
    const lower = hostname.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }

  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
}

function isSafeRemoteUrl(value: string, allowHttp = false) {
  try {
    const url = new URL(value);
    if (allowHttp) {
      if (!['https:', 'http:'].includes(url.protocol)) return false;
    } else if (url.protocol !== 'https:') {
      return false;
    }

    const host = url.hostname.toLowerCase();

    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (isPrivateIp(host)) return false;
    if (host.includes('\u0000')) return false;

    return true;
  } catch {
    return false;
  }
}

async function callExternalModerationProvider(kind: 'image' | 'video', url: string): Promise<{ signals: ModerationSignal[] } | null> {
  const endpoint = process.env.MODERATION_API_URL;
  const apiKey = process.env.MODERATION_API_KEY;

  if (!endpoint || !apiKey) return null;
  if (!isSafeRemoteUrl(endpoint, false)) return null;

  const { data } = await axios.post(
    endpoint,
    { type: kind, url },
    {
      timeout: Number(process.env.MODERATION_API_TIMEOUT_MS || 8000),
      maxRedirects: 0,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const signals: ModerationSignal[] = [];

  const adult = clamp(Number(data?.adult || data?.nudity || data?.sexual || 0));
  const violence = clamp(Number(data?.violence || data?.violent || 0));
  const hate = clamp(Number(data?.hate || data?.hateful || 0));
  const selfHarm = clamp(Number(data?.selfHarm || data?.self_harm || 0));
  const scam = clamp(Number(data?.scam || data?.fraud || 0));
  const spam = clamp(Number(data?.spam || 0));

  if (adult >= 0.65) {
    signals.push({
      type: 'adult',
      reason: 'age_restricted_visual_content',
      score: adult,
      severity: adult >= 0.9 ? 'high' : 'medium'
    });
  }

  if (violence >= 0.72) {
    signals.push({
      type: 'violence',
      reason: 'violent_visual_content',
      score: violence,
      severity: violence >= 0.92 ? 'critical' : 'high'
    });
  }

  if (hate >= 0.72) {
    signals.push({
      type: 'hate',
      reason: 'hateful_visual_content',
      score: hate,
      severity: hate >= 0.92 ? 'critical' : 'high'
    });
  }

  if (selfHarm >= 0.7) {
    signals.push({
      type: 'self_harm',
      reason: 'self_harm_visual_content',
      score: selfHarm,
      severity: selfHarm >= 0.9 ? 'high' : 'medium'
    });
  }

  if (scam >= 0.72) {
    signals.push({
      type: 'scam',
      reason: 'scam_visual_or_metadata_content',
      score: scam,
      severity: scam >= 0.9 ? 'high' : 'medium'
    });
  }

  if (spam >= 0.72) {
    signals.push({
      type: 'spam',
      reason: 'spam_visual_or_metadata_content',
      score: spam,
      severity: spam >= 0.9 ? 'high' : 'medium'
    });
  }

  return { signals };
}

async function checkUserRisk(userId: string): Promise<ModerationSignal[]> {
  const signals: ModerationSignal[] = [];
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [reportsAgainstUser, actionedReports, recentRejectedReels, moderationReports] = await Promise.all([
    (prisma as any).report?.count?.({
      where: {
        reportedUserId: userId,
        createdAt: { gte: since30d }
      }
    }).catch(() => 0) || 0,
    (prisma as any).report?.count?.({
      where: {
        reportedUserId: userId,
        status: { in: ['actioned', 'resolved', 'accepted'] },
        createdAt: { gte: since30d }
      }
    }).catch(() => 0) || 0,
    prisma.reel.count({
      where: {
        userId,
        moderationStatus: toPrismaModerationStatus('rejected'),
        createdAt: { gte: since30d }
      } as any
    }).catch(() => 0),
    (prisma as any).moderationReport?.count?.({
      where: {
        userId,
        status: { in: [toPrismaModerationStatus('rejected'), toPrismaModerationStatus('pending')] },
        createdAt: { gte: since30d }
      }
    }).catch(() => 0) || 0
  ]);

  if (actionedReports >= 3 || recentRejectedReels >= 3 || moderationReports >= 5) {
    signals.push({
      type: 'user_history',
      reason: 'repeat_policy_violation_history',
      score: 0.82,
      severity: 'high'
    });
  } else if (reportsAgainstUser >= 8 || actionedReports >= 1 || recentRejectedReels >= 1 || moderationReports >= 2) {
    signals.push({
      type: 'user_history',
      reason: 'elevated_user_risk',
      score: 0.58,
      severity: 'medium'
    });
  }

  return signals;
}

async function checkRateAbuse(userId: string, contentType?: string): Promise<ModerationSignal[]> {
  const signals: ModerationSignal[] = [];

  if (!contentType) return signals;

  const since10m = new Date(Date.now() - 10 * 60 * 1000);
  const since1h = new Date(Date.now() - 60 * 60 * 1000);

  if (contentType === 'comment') {
    const count = await prisma.comment.count({
      where: {
        userId,
        createdAt: { gte: since10m }
      } as any
    }).catch(() => 0);

    if (count >= 25) {
      signals.push({
        type: 'rate_abuse',
        reason: 'comment_rate_abuse',
        score: 0.75,
        severity: 'medium'
      });
    }
  }

  if (contentType === 'message') {
    const count = await prisma.message.count({
      where: {
        senderId: userId,
        createdAt: { gte: since10m }
      } as any
    }).catch(() => 0);

    if (count >= 60) {
      signals.push({
        type: 'rate_abuse',
        reason: 'message_rate_abuse',
        score: 0.74,
        severity: 'medium'
      });
    }
  }

  if (contentType === 'reel') {
    const count = await prisma.reel.count({
      where: {
        userId,
        createdAt: { gte: since1h }
      } as any
    }).catch(() => 0);

    if (count >= 12) {
      signals.push({
        type: 'rate_abuse',
        reason: 'reel_upload_rate_abuse',
        score: 0.72,
        severity: 'medium'
      });
    }
  }

  if (contentType === 'story') {
    const count = await prisma.story.count({
      where: {
        userId,
        createdAt: { gte: since1h }
      } as any
    }).catch(() => 0);

    if (count >= 40) {
      signals.push({
        type: 'rate_abuse',
        reason: 'story_post_rate_abuse',
        score: 0.68,
        severity: 'medium'
      });
    }
  }

  return signals;
}

async function persistModerationLog(input: ModerationInput, result: ModerationResult) {
  const data = {
    userId: input.userId,
    contentId: input.contentId || null,
    contentType: input.contentType || null,
    status: result.status,
    action: result.action,
    reason: result.reason || null,
    confidence: result.confidence,
    severity: result.severity,
    ageRestricted: result.ageRestricted,
    flagged: result.flagged,
    reviewRequired: result.reviewRequired,
    fingerprint: result.fingerprint || null,
    signals: safeJsonValue(result.signals),
    metadata: safeJsonValue(input.metadata || {})
  };

  if ((prisma as any).moderationLog?.create) {
    await (prisma as any).moderationLog.create({ data }).catch(() => null);
  }

  if ((prisma as any).moderationReport?.create && result.flagged) {
    await (prisma as any).moderationReport.create({
      data: {
        userId: input.userId,
        contentId: input.contentId || null,
        contentType: input.contentType || null,
        status: toPrismaModerationStatus(result.status),
        reason: result.reason || 'policy_review',
        confidence: result.confidence,
        metadata: {
          action: result.action,
          severity: result.severity,
          ageRestricted: result.ageRestricted,
          reviewRequired: result.reviewRequired,
          fingerprint: result.fingerprint,
          signals: result.signals,
          inputMetadata: input.metadata || {}
        }
      }
    }).catch(() => null);
  }
}

async function applyModerationDecision(input: ModerationInput, result: ModerationResult) {
  if (!input.contentId || !input.contentType) return;

  const moderationStatus = toPrismaModerationStatus(result.status);

  if (input.contentType === 'reel') {
    await prisma.reel.updateMany({
      where: { id: input.contentId, userId: input.userId } as any,
      data: {
        moderationStatus,
        flagged: result.flagged,
        isDraft: result.action === 'remove' ? true : undefined
      } as any
    }).catch(() => null);
    return;
  }

  if (input.contentType === 'comment') {
    await prisma.comment.updateMany({
      where: { id: input.contentId, userId: input.userId } as any,
      data: {
        moderationStatus,
        deletedAt: result.action === 'remove' ? new Date() : undefined
      } as any
    }).catch(() => null);
    return;
  }

  if (input.contentType === 'message') {
    await prisma.message.updateMany({
      where: { id: input.contentId, senderId: input.userId } as any,
      data: {
        deletedAt: result.action === 'remove' ? new Date() : undefined,
        moderationStatus
      } as any
    }).catch(() => null);
    return;
  }

  if (input.contentType === 'story') {
    await prisma.story.updateMany({
      where: { id: input.contentId, userId: input.userId } as any,
      data: {
        flagged: result.flagged,
        moderationStatus,
        deletedAt: result.action === 'remove' ? new Date() : undefined
      } as any
    }).catch(() => null);
    return;
  }

  if (input.contentType === 'profile') {
    await prisma.user.updateMany({
      where: { id: input.userId } as any,
      data: {
        profileModerationStatus: moderationStatus
      } as any
    }).catch(() => null);
  }
}

export async function approveContent(contentType: ModerationInput['contentType'], contentId: string, moderatorId?: string) {
  if (!contentType || !contentId) throw new Error('contentType and contentId are required');

  const status = toPrismaModerationStatus('approved');

  if (contentType === 'reel') {
    return prisma.reel.update({
      where: { id: contentId },
      data: { moderationStatus: status, flagged: false } as any
    });
  }

  if (contentType === 'comment') {
    return prisma.comment.update({
      where: { id: contentId },
      data: { moderationStatus: status } as any
    });
  }

  if (contentType === 'story') {
    return prisma.story.update({
      where: { id: contentId },
      data: { moderationStatus: status, flagged: false } as any
    });
  }

  if (contentType === 'message') {
    return prisma.message.update({
      where: { id: contentId },
      data: { moderationStatus: status } as any
    });
  }

  return {
    contentType,
    contentId,
    moderatorId: moderatorId || null,
    status: 'approved'
  };
}

export async function rejectContent(contentType: ModerationInput['contentType'], contentId: string, moderatorId?: string, reason?: string) {
  if (!contentType || !contentId) throw new Error('contentType and contentId are required');

  const status = toPrismaModerationStatus('rejected');

  if (contentType === 'reel') {
    return prisma.reel.update({
      where: { id: contentId },
      data: { moderationStatus: status, flagged: true, isDraft: true } as any
    });
  }

  if (contentType === 'comment') {
    return prisma.comment.update({
      where: { id: contentId },
      data: { moderationStatus: status, deletedAt: new Date() } as any
    });
  }

  if (contentType === 'story') {
    return prisma.story.update({
      where: { id: contentId },
      data: { moderationStatus: status, flagged: true, deletedAt: new Date() } as any
    });
  }

  if (contentType === 'message') {
    return prisma.message.update({
      where: { id: contentId },
      data: { moderationStatus: status, deletedAt: new Date() } as any
    });
  }

  return {
    contentType,
    contentId,
    moderatorId: moderatorId || null,
    reason: reason || null,
    status: 'rejected'
  };
}

export async function getModerationQueue(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const pendingStatus = toPrismaModerationStatus('pending');

  const [reels, comments, stories] = await Promise.all([
    prisma.reel.findMany({
      where: { moderationStatus: pendingStatus } as any,
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      include: {
        author: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true
          }
        }
      } as any
    }).catch(() => []),
    prisma.comment.findMany({
      where: { moderationStatus: pendingStatus } as any,
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true
          }
        }
      } as any
    }).catch(() => []),
    prisma.story.findMany({
      where: { moderationStatus: pendingStatus } as any,
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            avatarUrl: true,
            isVerified: true
          }
        }
      } as any
    }).catch(() => [])
  ]);

  return {
    reels,
    comments,
    stories,
    total: reels.length + comments.length + stories.length
  };
}
