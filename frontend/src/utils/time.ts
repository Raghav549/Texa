export type TimeInput = string | number | Date | null | undefined;

type FormatMessageTimeOptions = {
  locale?: string | string[];
  now?: Date;
  hour12?: boolean;
  showSeconds?: boolean;
  invalidFallback?: string;
};

type FormatTimeAgoOptions = {
  locale?: string | string[];
  now?: Date;
  numeric?: "always" | "auto";
  short?: boolean;
  invalidFallback?: string;
  futurePrefix?: string;
};

const DEFAULT_INVALID_FALLBACK = "";

const toDate = (value: TimeInput): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const startOfDay = (date: Date): Date => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const isSameDay = (a: Date, b: Date): boolean => {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

const isYesterday = (date: Date, now: Date): boolean => {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return isSameDay(date, yesterday);
};

const isTomorrow = (date: Date, now: Date): boolean => {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return isSameDay(date, tomorrow);
};

const isSameYear = (a: Date, b: Date): boolean => {
  return a.getFullYear() === b.getFullYear();
};

const pad2 = (value: number): string => {
  return String(value).padStart(2, "0");
};

const safeFormat = (formatter: () => string, fallback: string): string => {
  try {
    return formatter();
  } catch {
    return fallback;
  }
};

const formatClock = (date: Date, options: FormatMessageTimeOptions = {}): string => {
  const fallback = `${pad2(date.getHours())}:${pad2(date.getMinutes())}${options.showSeconds ? `:${pad2(date.getSeconds())}` : ""}`;
  return safeFormat(
    () =>
      new Intl.DateTimeFormat(options.locale, {
        hour: "2-digit",
        minute: "2-digit",
        second: options.showSeconds ? "2-digit" : undefined,
        hour12: options.hour12
      }).format(date),
    fallback
  );
};

const formatShortDate = (date: Date, options: FormatMessageTimeOptions = {}): string => {
  const fallback = `${date.toLocaleString(undefined, { month: "short" })} ${date.getDate()}`;
  return safeFormat(
    () =>
      new Intl.DateTimeFormat(options.locale, {
        month: "short",
        day: "numeric"
      }).format(date),
    fallback
  );
};

const formatFullDate = (date: Date, options: FormatMessageTimeOptions = {}): string => {
  const fallback = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return safeFormat(
    () =>
      new Intl.DateTimeFormat(options.locale, {
        year: "numeric",
        month: "short",
        day: "numeric"
      }).format(date),
    fallback
  );
};

const formatWeekday = (date: Date, options: FormatMessageTimeOptions = {}): string => {
  return safeFormat(
    () =>
      new Intl.DateTimeFormat(options.locale, {
        weekday: "short"
      }).format(date),
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
  );
};

export const formatMessageTime = (value: TimeInput, options: FormatMessageTimeOptions = {}): string => {
  const date = toDate(value);
  if (!date) return options.invalidFallback ?? DEFAULT_INVALID_FALLBACK;

  const now = options.now ?? new Date();
  const clock = formatClock(date, options);

  if (isSameDay(date, now)) return clock;
  if (isYesterday(date, now)) return `Yesterday ${clock}`;
  if (isTomorrow(date, now)) return `Tomorrow ${clock}`;

  const dayDiff = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86400000);
  if (dayDiff < 0 && dayDiff >= -6) return `${formatWeekday(date, options)} ${clock}`;
  if (dayDiff > 0 && dayDiff <= 6) return `${formatWeekday(date, options)} ${clock}`;

  if (isSameYear(date, now)) return `${formatShortDate(date, options)} ${clock}`;
  return `${formatFullDate(date, options)} ${clock}`;
};

export const formatTimeAgo = (value: TimeInput, options: FormatTimeAgoOptions = {}): string => {
  const date = toDate(value);
  if (!date) return options.invalidFallback ?? DEFAULT_INVALID_FALLBACK;

  const now = options.now ?? new Date();
  const diffMs = date.getTime() - now.getTime();
  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const isFuture = diffMs > 0;

  if (absSeconds < 5) return isFuture ? "now" : "just now";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1]
  ];

  const [unit, unitSeconds] = units.find(([, seconds]) => absSeconds >= seconds) ?? ["second", 1];
  const valueInUnit = Math.floor(absSeconds / unitSeconds);
  const signedValue = isFuture ? valueInUnit : -valueInUnit;

  if (options.short) {
    const shortUnitMap: Record<Intl.RelativeTimeFormatUnit, string> = {
      year: "y",
      quarter: "q",
      month: "mo",
      week: "w",
      day: "d",
      hour: "h",
      minute: "m",
      second: "s"
    };
    return isFuture ? `${options.futurePrefix ?? "in "}${valueInUnit}${shortUnitMap[unit]}` : `${valueInUnit}${shortUnitMap[unit]} ago`;
  }

  return safeFormat(
    () =>
      new Intl.RelativeTimeFormat(options.locale, {
        numeric: options.numeric ?? "auto",
        style: "long"
      }).format(signedValue, unit),
    isFuture ? `${options.futurePrefix ?? "in "}${valueInUnit} ${unit}${valueInUnit === 1 ? "" : "s"}` : `${valueInUnit} ${unit}${valueInUnit === 1 ? "" : "s"} ago`
  );
};

export const formatChatListTime = (value: TimeInput, options: FormatMessageTimeOptions = {}): string => {
  const date = toDate(value);
  if (!date) return options.invalidFallback ?? DEFAULT_INVALID_FALLBACK;

  const now = options.now ?? new Date();

  if (isSameDay(date, now)) return formatClock(date, options);
  if (isYesterday(date, now)) return "Yesterday";

  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000);
  if (dayDiff > 0 && dayDiff < 7) return formatWeekday(date, options);

  if (isSameYear(date, now)) return formatShortDate(date, options);
  return formatFullDate(date, options);
};

export const formatStoryTime = (value: TimeInput, options: FormatTimeAgoOptions = {}): string => {
  return formatTimeAgo(value, { ...options, short: true });
};

export const formatDuration = (secondsInput: number | null | undefined): string => {
  const totalSeconds = Math.max(0, Math.floor(Number(secondsInput) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${minutes}:${pad2(seconds)}`;
};

export const formatCallDuration = (secondsInput: number | null | undefined): string => {
  const totalSeconds = Math.max(0, Math.floor(Number(secondsInput) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

export const isExpired = (value: TimeInput, now: Date = new Date()): boolean => {
  const date = toDate(value);
  if (!date) return false;
  return date.getTime() <= now.getTime();
};

export const secondsUntil = (value: TimeInput, now: Date = new Date()): number => {
  const date = toDate(value);
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
};

export const minutesUntil = (value: TimeInput, now: Date = new Date()): number => {
  return Math.ceil(secondsUntil(value, now) / 60);
};

export const getDayLabel = (value: TimeInput, options: FormatMessageTimeOptions = {}): string => {
  const date = toDate(value);
  if (!date) return options.invalidFallback ?? DEFAULT_INVALID_FALLBACK;

  const now = options.now ?? new Date();

  if (isSameDay(date, now)) return "Today";
  if (isYesterday(date, now)) return "Yesterday";
  if (isTomorrow(date, now)) return "Tomorrow";
  if (isSameYear(date, now)) return formatShortDate(date, options);
  return formatFullDate(date, options);
};

export const groupByDay = <T extends Record<string, any>>(items: T[], key: keyof T = "createdAt"): Array<{ title: string; data: T[] }> => {
  const map = new Map<string, T[]>();

  for (const item of items) {
    const date = toDate(item[key]);
    const groupKey = date ? startOfDay(date).toISOString() : "invalid";
    const current = map.get(groupKey) ?? [];
    current.push(item);
    map.set(groupKey, current);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
    .map(([dateKey, data]) => ({
      title: dateKey === "invalid" ? "Unknown" : getDayLabel(dateKey),
      data
    }));
};

export const isWithinLast = (value: TimeInput, amount: number, unit: "seconds" | "minutes" | "hours" | "days" = "minutes", now: Date = new Date()): boolean => {
  const date = toDate(value);
  if (!date) return false;

  const multiplier = unit === "seconds" ? 1000 : unit === "minutes" ? 60000 : unit === "hours" ? 3600000 : 86400000;
  const diff = now.getTime() - date.getTime();

  return diff >= 0 && diff <= amount * multiplier;
};

export const sortByNewest = <T extends Record<string, any>>(items: T[], key: keyof T = "createdAt"): T[] => {
  return [...items].sort((a, b) => {
    const ad = toDate(a[key])?.getTime() ?? 0;
    const bd = toDate(b[key])?.getTime() ?? 0;
    return bd - ad;
  });
};

export const sortByOldest = <T extends Record<string, any>>(items: T[], key: keyof T = "createdAt"): T[] => {
  return [...items].sort((a, b) => {
    const ad = toDate(a[key])?.getTime() ?? 0;
    const bd = toDate(b[key])?.getTime() ?? 0;
    return ad - bd;
  });
};
