type NumberFormatMode = 'short' | 'compact' | 'full';
type DurationStyle = 'clock' | 'verbose' | 'digital';
type TimeAgoStyle = 'short' | 'long';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const safeNumber = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const safeDate = (value: string | number | Date | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const trimDecimal = (value: string): string => value.replace(/\.0$/, '');

const plural = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'}`;

export const formatNumber = (
  num: number,
  options?: {
    mode?: NumberFormatMode;
    decimals?: number;
    signed?: boolean;
    fallback?: string;
  }
): string => {
  const value = safeNumber(num, NaN);
  if (!Number.isFinite(value)) return options?.fallback ?? '0';

  const mode = options?.mode ?? 'short';
  const decimals = Math.max(0, Math.min(options?.decimals ?? 1, 2));
  const sign = options?.signed && value > 0 ? '+' : '';
  const abs = Math.abs(value);
  const negative = value < 0 ? '-' : '';

  if (mode === 'full') {
    return `${sign}${new Intl.NumberFormat('en-IN').format(value)}`;
  }

  if (mode === 'compact') {
    return `${sign}${new Intl.NumberFormat('en', {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: decimals
    }).format(value)}`;
  }

  const units = [
    { limit: 1_000_000_000_000, suffix: 'T' },
    { limit: 1_000_000_000, suffix: 'B' },
    { limit: 1_000_000, suffix: 'M' },
    { limit: 1_000, suffix: 'K' }
  ];

  for (const unit of units) {
    if (abs >= unit.limit) {
      return `${sign}${negative}${trimDecimal((abs / unit.limit).toFixed(decimals))}${unit.suffix}`;
    }
  }

  return `${sign}${new Intl.NumberFormat('en-IN').format(value)}`;
};

export const formatDuration = (
  seconds: number,
  options?: {
    style?: DurationStyle;
    showHours?: boolean;
    fallback?: string;
  }
): string => {
  const raw = safeNumber(seconds, NaN);
  if (!Number.isFinite(raw) || raw < 0) return options?.fallback ?? '0:00';

  const total = Math.floor(raw);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const style = options?.style ?? 'clock';

  if (style === 'verbose') {
    const parts: string[] = [];
    if (hrs) parts.push(plural(hrs, 'hour'));
    if (mins) parts.push(plural(mins, 'minute'));
    if (secs || parts.length === 0) parts.push(plural(secs, 'second'));
    return parts.join(' ');
  }

  if (style === 'digital') {
    const h = hrs.toString().padStart(2, '0');
    const m = mins.toString().padStart(2, '0');
    const s = secs.toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  if (hrs > 0 || options?.showHours) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const formatTimeAgo = (
  isoString: string | number | Date,
  options?: {
    style?: TimeAgoStyle;
    now?: number | Date;
    futurePrefix?: string;
    pastSuffix?: string;
    fallback?: string;
  }
): string => {
  const date = safeDate(isoString);
  if (!date) return options?.fallback ?? 'just now';

  const nowDate = options?.now instanceof Date ? options.now : new Date(options?.now ?? Date.now());
  const diff = nowDate.getTime() - date.getTime();
  const abs = Math.abs(diff);
  const isFuture = diff < 0;
  const style = options?.style ?? 'short';

  const futurePrefix = options?.futurePrefix ?? 'in ';
  const pastSuffix = options?.pastSuffix ?? ' ago';

  const build = (value: number, shortUnit: string, longUnit: string): string => {
    const unitText = style === 'long' ? plural(value, longUnit) : `${value}${shortUnit}`;
    return isFuture ? `${futurePrefix}${unitText}` : `${unitText}${pastSuffix}`;
  };

  if (abs < 10 * SECOND) return isFuture ? 'now' : 'just now';
  if (abs < MINUTE) return build(Math.floor(abs / SECOND), 's', 'second');
  if (abs < HOUR) return build(Math.floor(abs / MINUTE), 'm', 'minute');
  if (abs < DAY) return build(Math.floor(abs / HOUR), 'h', 'hour');
  if (abs < WEEK) return build(Math.floor(abs / DAY), 'd', 'day');
  if (abs < MONTH) return build(Math.floor(abs / WEEK), 'w', 'week');
  if (abs < YEAR) return build(Math.floor(abs / MONTH), 'mo', 'month');
  return build(Math.floor(abs / YEAR), 'y', 'year');
};

export const formatMessageTime = (
  value: string | number | Date,
  options?: {
    fallback?: string;
    locale?: string;
    hour12?: boolean;
  }
): string => {
  const date = safeDate(value);
  if (!date) return options?.fallback ?? '';

  const locale = options?.locale ?? 'en-IN';
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  const sameDay = date.toDateString() === now.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const sameYear = date.getFullYear() === now.getFullYear();

  const time = date.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: options?.hour12 ?? true
  });

  if (sameDay) return time;
  if (isYesterday) return `Yesterday, ${time}`;

  const dateText = date.toLocaleDateString(locale, sameYear ? {
    day: 'numeric',
    month: 'short'
  } : {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });

  return `${dateText}, ${time}`;
};

export const formatDateHeader = (
  value: string | number | Date,
  options?: {
    fallback?: string;
    locale?: string;
  }
): string => {
  const date = safeDate(value);
  if (!date) return options?.fallback ?? '';

  const locale = options?.locale ?? 'en-IN';
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  });
};

export const formatViews = (num: number): string => `${formatNumber(num)} views`;

export const formatFollowers = (num: number): string => `${formatNumber(num)} followers`;

export const formatCoins = (
  num: number,
  options?: {
    symbol?: string;
    full?: boolean;
  }
): string => {
  const symbol = options?.symbol ?? '◈';
  return `${symbol} ${formatNumber(num, { mode: options?.full ? 'full' : 'short' })}`;
};

export const formatPercent = (
  value: number,
  options?: {
    decimals?: number;
    fallback?: string;
  }
): string => {
  const n = safeNumber(value, NaN);
  if (!Number.isFinite(n)) return options?.fallback ?? '0%';
  const decimals = Math.max(0, Math.min(options?.decimals ?? 0, 2));
  return `${trimDecimal((n * 100).toFixed(decimals))}%`;
};

export const formatFileSize = (
  bytes: number,
  options?: {
    decimals?: number;
    fallback?: string;
  }
): string => {
  const value = safeNumber(bytes, NaN);
  if (!Number.isFinite(value) || value < 0) return options?.fallback ?? '0 B';

  const decimals = Math.max(0, Math.min(options?.decimals ?? 1, 2));
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${trimDecimal(size.toFixed(index === 0 ? 0 : decimals))} ${units[index]}`;
};

export const formatUsername = (username?: string | null): string => {
  if (!username) return '@unknown';
  const clean = username.trim().replace(/^@+/, '');
  return clean ? `@${clean}` : '@unknown';
};

export const formatHashtag = (tag?: string | null): string => {
  if (!tag) return '';
  const clean = tag.trim().replace(/^#+/, '').replace(/\s+/g, '');
  return clean ? `#${clean}` : '';
};

export const formatListPreview = (
  items: string[],
  options?: {
    limit?: number;
    fallback?: string;
  }
): string => {
  const clean = items.filter(Boolean);
  if (!clean.length) return options?.fallback ?? '';
  const limit = options?.limit ?? 2;
  const visible = clean.slice(0, limit);
  const extra = clean.length - visible.length;
  return extra > 0 ? `${visible.join(', ')} +${extra}` : visible.join(', ');
};

export const getInitials = (name?: string | null): string => {
  if (!name?.trim()) return 'TX';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(part => part.charAt(0).toUpperCase()).join('');
};

export const formatLiveCount = (num: number): string => `${formatNumber(num)} watching`;

export const formatEngagement = (likes: number, comments: number, shares: number): string => {
  const total = safeNumber(likes) + safeNumber(comments) + safeNumber(shares);
  return formatNumber(total);
};

export const formatUploadProgress = (loaded: number, total?: number): string => {
  const l = safeNumber(loaded);
  const t = safeNumber(total);
  if (!t || t <= 0) return `${formatFileSize(l)} uploaded`;
  return `${formatPercent(l / t)} • ${formatFileSize(l)} / ${formatFileSize(t)}`;
};
