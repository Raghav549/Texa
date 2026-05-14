import axios, { AxiosResponse } from "axios";
import * as cheerio from "cheerio";
import dns from "dns/promises";
import net from "net";
import { URL } from "url";
import crypto from "crypto";

export interface LinkPreview {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  type: string | null;
  favicon: string | null;
  fetchedAt: string;
}

export interface ExtractedSocialData {
  links: string[];
  mentions: string[];
  hashtags: string[];
}

const MAX_CONTENT_LENGTH = 250000;
const MAX_PARSE_LENGTH = 120000;
const MAX_LINKS = 3;
const REQUEST_TIMEOUT = 4500;
const MAX_REDIRECTS = 3;
const USER_AGENT = process.env.LINK_PREVIEW_USER_AGENT || "TexaBot/1.0 (+https://texa.app)";
const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.6,*/*;q=0.4";

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal"
]);

const blockedIpRanges = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.1[89]\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^224\./,
  /^240\./,
  /^255\.255\.255\.255$/
];

const normalizeText = (value?: string | null, max = 280): string | null => {
  if (!value) return null;

  const cleaned = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;

  return cleaned.length > max ? `${cleaned.slice(0, Math.max(1, max - 1)).trim()}…` : cleaned;
};

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const stripWww = (hostname: string) => hostname.replace(/^www\./i, "");

const isIpv4Private = (ip: string) => blockedIpRanges.some(pattern => pattern.test(ip));

const isIpv6Private = (ip: string) => {
  const value = ip.toLowerCase();

  return (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.") ||
    /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(value)
  );
};

const isBlockedIp = (ip: string) => {
  const version = net.isIP(ip);

  if (version === 4) return isIpv4Private(ip);
  if (version === 6) return isIpv6Private(ip);

  return true;
};

const normalizeHostname = (hostname: string) => {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
};

const isBlockedHostname = (hostname: string) => {
  const host = normalizeHostname(hostname);

  if (!host) return true;
  if (blockedHostnames.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;
  if (host.endsWith(".test")) return true;
  if (host.endsWith(".invalid")) return true;

  const ipVersion = net.isIP(host);

  if (ipVersion) return isBlockedIp(host);

  return false;
};

const assertSafeResolvedHost = async (hostname: string) => {
  const host = normalizeHostname(hostname);

  if (isBlockedHostname(host)) throw new Error("Blocked host");

  const records = await dns.lookup(host, { all: true, verbatim: true });

  if (!records.length) throw new Error("Host cannot be resolved");

  for (const record of records) {
    if (isBlockedIp(record.address)) throw new Error("Blocked network");
  }

  return true;
};

const safeUrl = (raw: string): string | null => {
  try {
    const value = String(raw || "").trim();

    if (!value || value.length > 2048) return null;

    const parsed = new URL(value);

    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!parsed.hostname || isBlockedHostname(parsed.hostname)) return null;

    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
};

const absolutizeUrl = (baseUrl: string, value?: string | null): string | null => {
  if (!value) return null;

  try {
    const parsed = new URL(String(value).trim(), baseUrl);

    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!parsed.hostname || isBlockedHostname(parsed.hostname)) return null;

    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";

    return parsed.toString();
  } catch {
    return null;
  }
};

const getMeta = ($: cheerio.CheerioAPI, selectors: string[], max = 500): string | null => {
  for (const selector of selectors) {
    const element = $(selector).first();
    const value = element.attr("content") || element.attr("value") || element.attr("title");

    const normalized = normalizeText(value, max);

    if (normalized) return normalized;
  }

  return null;
};

const getTitle = ($: cheerio.CheerioAPI): string | null => {
  return normalizeText(
    getMeta(
      $,
      [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
        'meta[property="twitter:title"]',
        'meta[itemprop="name"]',
        'meta[name="title"]'
      ],
      160
    ) ||
      $("title").first().text() ||
      $("h1").first().text(),
    160
  );
};

const getDescription = ($: cheerio.CheerioAPI): string | null => {
  return normalizeText(
    getMeta(
      $,
      [
        'meta[property="og:description"]',
        'meta[name="og:description"]',
        'meta[name="description"]',
        'meta[name="twitter:description"]',
        'meta[property="twitter:description"]',
        'meta[itemprop="description"]'
      ],
      500
    ),
    300
  );
};

const getSiteName = ($: cheerio.CheerioAPI, domain: string): string | null => {
  return normalizeText(
    getMeta(
      $,
      [
        'meta[property="og:site_name"]',
        'meta[name="application-name"]',
        'meta[name="apple-mobile-web-app-title"]'
      ],
      120
    ) || domain,
    120
  );
};

const getType = ($: cheerio.CheerioAPI, fallback?: string): string | null => {
  return normalizeText(
    getMeta(
      $,
      [
        'meta[property="og:type"]',
        'meta[name="twitter:card"]',
        'meta[property="twitter:card"]'
      ],
      120
    ) || fallback,
    120
  );
};

const chooseBestImageFromDom = ($: cheerio.CheerioAPI) => {
  const images = $("img")
    .map((_, el) => {
      const item = $(el);
      const src = item.attr("src") || item.attr("data-src") || item.attr("data-original") || item.attr("data-lazy-src");
      const width = Number(item.attr("width") || item.attr("data-width") || 0);
      const height = Number(item.attr("height") || item.attr("data-height") || 0);
      const score = width * height;

      return src ? { src, score } : null;
    })
    .get()
    .filter(Boolean) as Array<{ src: string; score: number }>;

  return images.sort((a, b) => b.score - a.score)[0]?.src || null;
};

const getImage = ($: cheerio.CheerioAPI, baseUrl: string): string | null => {
  const image =
    getMeta(
      $,
      [
        'meta[property="og:image:secure_url"]',
        'meta[property="og:image:url"]',
        'meta[property="og:image"]',
        'meta[name="og:image"]',
        'meta[name="twitter:image"]',
        'meta[property="twitter:image"]',
        'meta[itemprop="image"]'
      ],
      1200
    ) ||
    chooseBestImageFromDom($);

  return absolutizeUrl(baseUrl, image);
};

const getFavicon = ($: cheerio.CheerioAPI, baseUrl: string): string | null => {
  const icons = [
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
    'link[rel="shortcut icon"]',
    'link[rel="icon"]',
    'link[rel="mask-icon"]'
  ];

  for (const selector of icons) {
    const href = $(selector).first().attr("href");
    const absolute = absolutizeUrl(baseUrl, href);

    if (absolute) return absolute;
  }

  return absolutizeUrl(baseUrl, "/favicon.ico");
};

const getCanonicalUrl = ($: cheerio.CheerioAPI, baseUrl: string): string | null => {
  return (
    absolutizeUrl(baseUrl, $('link[rel="canonical"]').first().attr("href")) ||
    absolutizeUrl(
      baseUrl,
      getMeta(
        $,
        [
          'meta[property="og:url"]',
          'meta[name="twitter:url"]'
        ],
        1200
      )
    )
  );
};

const fallbackPreview = (url: string, type: string | null = null): LinkPreview | null => {
  try {
    const parsed = new URL(url);
    const domain = stripWww(parsed.hostname);

    return {
      url,
      normalizedUrl: url,
      domain,
      title: domain,
      description: null,
      image: null,
      siteName: domain,
      type,
      favicon: `${parsed.protocol}//${parsed.hostname}/favicon.ico`,
      fetchedAt: new Date().toISOString()
    };
  } catch {
    return null;
  }
};

const validateRedirect = async (response: AxiosResponse) => {
  const finalUrl = response.request?.res?.responseUrl || response.config.url;

  if (!finalUrl) return null;

  const safeFinal = safeUrl(finalUrl);

  if (!safeFinal) throw new Error("Unsafe redirect");

  await assertSafeResolvedHost(new URL(safeFinal).hostname);

  return safeFinal;
};

const fetchPreviewHtml = async (url: string) => {
  await assertSafeResolvedHost(new URL(url).hostname);

  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    maxRedirects: MAX_REDIRECTS,
    responseType: "text",
    maxContentLength: MAX_CONTENT_LENGTH,
    maxBodyLength: MAX_CONTENT_LENGTH,
    decompress: true,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: DEFAULT_ACCEPT,
      "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
      "Cache-Control": "no-cache"
    },
    validateStatus: status => status >= 200 && status < 400
  });

  const finalUrl = (await validateRedirect(response)) || url;

  return {
    response,
    finalUrl
  };
};

const parseHtmlPreview = (url: string, finalUrl: string, html: string, contentType: string | null): LinkPreview => {
  const safeHtml = String(html || "").slice(0, MAX_PARSE_LENGTH);
  const $ = cheerio.load(safeHtml);
  const canonical = getCanonicalUrl($, finalUrl);
  const normalizedUrl = safeUrl(canonical || finalUrl) || finalUrl;
  const parsed = new URL(normalizedUrl);
  const domain = stripWww(parsed.hostname);

  return {
    url,
    normalizedUrl,
    domain,
    title: getTitle($) || domain,
    description: getDescription($),
    image: getImage($, normalizedUrl),
    siteName: getSiteName($, domain),
    type: getType($, contentType || null),
    favicon: getFavicon($, normalizedUrl),
    fetchedAt: new Date().toISOString()
  };
};

const extractUrls = (content: string): string[] => {
  const value = String(content || "");

  if (!value) return [];

  const urlRegex = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;

  return unique(
    (value.match(urlRegex) || [])
      .map(url => url.replace(/[)\].,!?:;]+$/g, ""))
      .map(url => safeUrl(url))
      .filter((url): url is string => Boolean(url))
  ).slice(0, MAX_LINKS);
};

export const extractMentions = (content: string): string[] => {
  if (!content) return [];

  const regex = /(^|[\s([{])@([\p{L}\p{N}_]{2,30})(?![\p{L}\p{N}_.]*\.[\p{L}]{2,})/gu;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    mentions.push(match[2].toLowerCase());
  }

  return unique(mentions);
};

export const extractHashtags = (content: string): string[] => {
  if (!content) return [];

  const regex = /(^|[\s([{])#([\p{L}\p{N}_]{2,50})/gu;
  const hashtags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    hashtags.push(match[2].toLowerCase());
  }

  return unique(hashtags);
};

export const extractLinks = (content: string): string[] => {
  return extractUrls(content);
};

export const extractSocialData = (content: string): ExtractedSocialData => {
  return {
    links: extractLinks(content),
    mentions: extractMentions(content),
    hashtags: extractHashtags(content)
  };
};

export const createPreviewCacheKey = (url: string) => {
  const safe = safeUrl(url) || url;
  return `link_preview:${sha256(safe)}`;
};

export const generateSingleLinkPreview = async (url: string): Promise<LinkPreview | null> => {
  const safe = safeUrl(url);

  if (!safe) return null;

  try {
    const { response, finalUrl } = await fetchPreviewHtml(safe);
    const contentType = String(response.headers["content-type"] || "").toLowerCase() || null;

    if (!contentType || !contentType.includes("text/html")) {
      return fallbackPreview(finalUrl, contentType);
    }

    return parseHtmlPreview(safe, finalUrl, String(response.data || ""), contentType);
  } catch {
    return fallbackPreview(safe);
  }
};

export const generateLinkPreview = async (content: string): Promise<LinkPreview[]> => {
  const urls = extractUrls(content);

  if (!urls.length) return [];

  const previews = await Promise.all(urls.map(url => generateSingleLinkPreview(url)));

  return previews.filter((preview): preview is LinkPreview => Boolean(preview));
};

export const normalizePreviewUrl = safeUrl;

export const isSafePreviewUrl = async (url: string): Promise<boolean> => {
  const safe = safeUrl(url);

  if (!safe) return false;

  try {
    await assertSafeResolvedHost(new URL(safe).hostname);
    return true;
  } catch {
    return false;
  }
};
