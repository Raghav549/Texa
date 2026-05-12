import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";

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

const MAX_CONTENT_LENGTH = 5000;
const MAX_LINKS = 3;
const REQUEST_TIMEOUT = 4500;
const USER_AGENT = "TexaBot/1.0 (+https://texa.app)";

const privateHostPatterns = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i
];

const normalizeText = (value?: string | null, max = 280): string | null => {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trim()}…` : cleaned;
};

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return privateHostPatterns.some((pattern) => pattern.test(host));
};

const safeUrl = (raw: string): string | null => {
  try {
    const parsed = new URL(raw.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (isPrivateHost(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

const absolutizeUrl = (baseUrl: string, value?: string | null): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value, baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (isPrivateHost(parsed.hostname)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

const getMeta = ($: cheerio.CheerioAPI, selectors: string[]): string | null => {
  for (const selector of selectors) {
    const value = $(selector).attr("content") || $(selector).attr("value");
    const normalized = normalizeText(value, 500);
    if (normalized) return normalized;
  }
  return null;
};

const getTitle = ($: cheerio.CheerioAPI): string | null => {
  return normalizeText(
    getMeta($, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[itemprop="name"]'
    ]) || $("title").first().text(),
    120
  );
};

const getDescription = ($: cheerio.CheerioAPI): string | null => {
  return normalizeText(
    getMeta($, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
      'meta[itemprop="description"]'
    ]),
    280
  );
};

const getImage = ($: cheerio.CheerioAPI, baseUrl: string): string | null => {
  const image =
    getMeta($, [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[itemprop="image"]'
    ]) ||
    $("img")
      .map((_, el) => $(el).attr("src"))
      .get()
      .find(Boolean) ||
    null;

  return absolutizeUrl(baseUrl, image);
};

const getFavicon = ($: cheerio.CheerioAPI, baseUrl: string): string | null => {
  const icon =
    $('link[rel="apple-touch-icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    $('link[rel="icon"]').attr("href") ||
    "/favicon.ico";

  return absolutizeUrl(baseUrl, icon);
};

const extractUrls = (content: string): string[] => {
  const urlRegex = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;
  return unique(
    (content.match(urlRegex) || [])
      .map((url) => url.replace(/[),.!?;:]+$/g, ""))
      .map((url) => safeUrl(url))
      .filter((url): url is string => Boolean(url))
  ).slice(0, MAX_LINKS);
};

export const extractMentions = (content: string): string[] => {
  if (!content) return [];
  const regex = /(^|[\s([{])@([a-zA-Z0-9_]{2,30})(?![a-zA-Z0-9_.]*\.[a-zA-Z]{2,})/g;
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
  if (!content) return [];
  return extractUrls(content);
};

export const generateLinkPreview = async (content: string): Promise<LinkPreview[]> => {
  const urls = extractUrls(content);

  const previews = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await axios.get(url, {
          timeout: REQUEST_TIMEOUT,
          maxRedirects: 3,
          responseType: "text",
          maxContentLength: MAX_CONTENT_LENGTH,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          validateStatus: (status) => status >= 200 && status < 400
        });

        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("text/html")) {
          const parsed = new URL(url);
          return {
            url,
            normalizedUrl: url,
            domain: parsed.hostname.replace(/^www\./, ""),
            title: parsed.hostname.replace(/^www\./, ""),
            description: null,
            image: null,
            siteName: null,
            type: contentType || null,
            favicon: `${parsed.protocol}//${parsed.hostname}/favicon.ico`,
            fetchedAt: new Date().toISOString()
          };
        }

        const html = String(response.data || "").slice(0, MAX_CONTENT_LENGTH);
        const $ = cheerio.load(html);
        const finalUrl = safeUrl(response.request?.res?.responseUrl || url) || url;
        const parsed = new URL(finalUrl);
        const domain = parsed.hostname.replace(/^www\./, "");

        const preview: LinkPreview = {
          url,
          normalizedUrl: finalUrl,
          domain,
          title: getTitle($) || domain,
          description: getDescription($),
          image: getImage($, finalUrl),
          siteName: normalizeText(
            getMeta($, [
              'meta[property="og:site_name"]',
              'meta[name="application-name"]'
            ]),
            80
          ),
          type: normalizeText(
            getMeta($, [
              'meta[property="og:type"]',
              'meta[name="twitter:card"]'
            ]),
            80
          ),
          favicon: getFavicon($, finalUrl),
          fetchedAt: new Date().toISOString()
        };

        return preview;
      } catch {
        try {
          const parsed = new URL(url);
          return {
            url,
            normalizedUrl: url,
            domain: parsed.hostname.replace(/^www\./, ""),
            title: parsed.hostname.replace(/^www\./, ""),
            description: null,
            image: null,
            siteName: null,
            type: null,
            favicon: `${parsed.protocol}//${parsed.hostname}/favicon.ico`,
            fetchedAt: new Date().toISOString()
          };
        } catch {
          return null;
        }
      }
    })
  );

  return previews.filter((preview): preview is LinkPreview => Boolean(preview));
};
