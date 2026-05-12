import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../config/db';

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
      /\b(hate\s*speech|racial\s*slur|kill\s+all|exterminate\s+all)\b/i
    ]
  },
  {
    type: 'violence',
    reason: 'violent_threat_or_instruction',
    severity: 'critical',
    score: 0.97,
    reject: true,
    patterns: [
      /\b(i\s*will\s*kill\s*you|murder\s*you|shoot\s*you|stab\s*you|bomb\s*threat)\b/i,
      /\b(how\s*to\s*make\s*a\s*bomb|make\s*explosive|build\s*explosive)\b/i
    ]
  },
  {
    type: 'self_harm',
    reason: 'self_harm_or_suicide_content',
    severity: 'high',
    score: 0.92,
    reject: false,
    patterns: [
      /\b(suicide|self\s*harm|kill\s*myself|end\s*my\s*life|cut\s*myself)\b/i
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
      /\b(explicit\s*content|porn|nude|nudity|xxx|adult\s*video|sexually\s*explicit)\b/i
    ]
  },
  {
    type: 'harassment',
    reason: 'harassment_or_bullying',
    severity: 'medium',
    score: 0.82,
    reject: false,
    patterns: [
      /\b(go\s*die|worthless|ugly\s*trash|stupid\s*idiot|publicly\s*shame)\b/i
    ]
  },
  {
    type: 'scam',
    reason: 'scam_or_financial_fraud',
    severity: 'high',
    score: 0.91,
    reject: false,
    patterns: [
      /\b(guaranteed\s*profit|double\s*your\s*money|free\s*crypto|send\s*otp|share\s*password|bank\s*otp)\b/i,
      /\b(telegram\s*investment|whatsapp\s*earning|risk\s*free\s*trading)\b/i
    ]
  },
  {
    type: 'illegal',
    reason: 'illegal_goods_or_services',
    severity: 'high',
    score: 0.93,
    reject: false,
    patterns: [
      /\b(buy\s*drugs|sell\s*drugs|fake\s*passport|fake\s*id|stolen\s*card|carding|cvv)\b/i
    ]
  },
  {
    type: 'spam',
    reason: 'spam_or_engagement_manipulation',
    severity: 'medium',
    score: 0.76,
    reject: false,
    patterns: [
      /\b(follow\s*for\s*follow|like\s*for\s*like|1000\s*followers|free\s*followers|bot\s*followers)\b/i
    ]
  }
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const SUSPICIOUS_TLDS = new Set(['zip', 'mov', 'click', 'work', 'rest', 'cam', 'country', 'gq', 'tk', 'ml']);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'ow.ly']);

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();

const hashContent = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const clamp = (value: number, min = 0, max = 1) => Math.min(Math.max(value, min), max);

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

export async function moderateContent(input: ModerationInput): Promise<ModerationResult> {
  const signals: ModerationSignal[] = [];
  const normalizedText = input.text ? normalizeText(input.text) : '';
  const fingerprint = hashContent(JSON.stringify({
    userId: input.userId,
    contentType: input.contentType || 'unknown',
    text: normalizedText || null,
    videoUrl: input.videoUrl || null,
    imageUrl: input.imageUrl || null
  }));

  if (normalizedText) {
    signals.push(...checkTextModeration(normalizedText));
    signals.push(...checkUrlModeration(normalizedText));
    signals.push(...checkSpamHeuristics(normalizedText));
  }

  if (input.imageUrl) {
    signals.push(...await analyzeImageContent(input.imageUrl));
  }

  if (input.videoUrl) {
    signals.push(...await analyzeVideoContent(input.videoUrl));
  }

  signals.push(...await checkUserRisk(input.userId));
  signals.push(...await checkRateAbuse(input.userId, input.contentType));

  const severity = maxSeverity(signals);
  const confidence = clamp(signals.length ? Math.max(...signals.map((s) => s.score)) : 0.99);
  const ageRestricted = signals.some((s) => s.type === 'adult') || signals.some((s) => s.reason.includes('age_restricted'));
  const hasRejectSignal = signals.some((s) => s.severity === 'critical' || s.reason.includes('violent_threat') || s.reason.includes('hate_or_dehumanizing'));
  const decision = scoreToStatus(confidence, severity, hasRejectSignal, ageRestricted);
  const reason = signals.length
    ? signals.sort((a, b) => b.score - a.score)[0]?.reason
    : undefined;

  const result: ModerationResult = {
    status: decision.status,
    flagged: decision.flagged,
    reason,
    ageRestricted,
    confidence,
    severity,
    signals: signals.sort((a, b) => b.score - a.score),
    action: decision.action,
    reviewRequired: decision.reviewRequired,
    fingerprint
  };

  await persistModerationLog(input, result).catch(() => undefined);

  return result;
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

  const repeatedChars = /(.)\1{8,}/i.test(text);
  if (repeatedChars) {
    signals.push({
      type: 'spam',
      reason: 'repeated_character_spam_pattern',
      score: 0.48,
      severity: 'low'
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

      if (/(login|verify|wallet|airdrop|bonus|free|claim|gift|otp|password)/i.test(parsed.href)) {
        signals.push({
          type: 'scam',
          reason: 'phishing_like_url_pattern',
          score: 0.78,
          severity: 'high',
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

function isSafeRemoteUrl(value: string) {
  try {
    const url = new URL(value);
    if (!['https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
    if (/^(10|127|169\.254|172\.(1[6-9]|2\d|3[0-1])|192\.168)\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function callExternalModerationProvider(kind: 'image' | 'video', url: string): Promise<{ signals: ModerationSignal[] } | null> {
  const endpoint = process.env.MODERATION_API_URL;
  const apiKey = process.env.MODERATION_API_KEY;

  if (!endpoint || !apiKey) return null;

  const { data } = await axios.post(
    endpoint,
    { type: kind, url },
    {
      timeout: 8000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const signals: ModerationSignal[] = [];

  const adult = clamp(Number(data?.adult || data?.nudity || 0));
  const violence = clamp(Number(data?.violence || 0));
  const hate = clamp(Number(data?.hate || 0));
  const selfHarm = clamp(Number(data?.selfHarm || data?.self_harm || 0));

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

  return { signals };
}

async function checkUserRisk(userId: string): Promise<ModerationSignal[]> {
  const signals: ModerationSignal[] = [];

  const [reportsAgainstUser, actionedReports, recentRejectedReels] = await Promise.all([
    prisma.reelReport.count({
      where: {
        reel: { userId },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      } as any
    }).catch(() => 0),
    prisma.reelReport.count({
      where: {
        reel: { userId },
        status: 'actioned'
      } as any
    }).catch(() => 0),
    prisma.reel.count({
      where: {
        userId,
        moderationStatus: 'rejected',
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      } as any
    }).catch(() => 0)
  ]);

  if (actionedReports >= 3 || recentRejectedReels >= 3) {
    signals.push({
      type: 'user_history',
      reason: 'repeat_policy_violation_history',
      score: 0.82,
      severity: 'high'
    });
  } else if (reportsAgainstUser >= 8 || actionedReports >= 1 || recentRejectedReels >= 1) {
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

  const since = new Date(Date.now() - 10 * 60 * 1000);

  if (contentType === 'comment') {
    const count = await prisma.comment.count({
      where: {
        userId,
        createdAt: { gte: since }
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

  if (contentType === 'reel') {
    const count = await prisma.reel.count({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
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

  return signals;
}

async function persistModerationLog(input: ModerationInput, result: ModerationResult) {
  const model = (prisma as any).moderationLog;
  if (!model?.create) return;

  await model.create({
    data: {
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
      signals: result.signals,
      metadata: input.metadata || {}
    }
  });
}
