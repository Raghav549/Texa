import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ObjectCannedACL
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuid } from "uuid";
import path from "path";
import crypto from "crypto";

type UploadFolder =
  | "avatars"
  | "covers"
  | "posts"
  | "stories"
  | "reels"
  | "messages"
  | "voice"
  | "documents"
  | "products"
  | "stores"
  | "reports"
  | "temp"
  | string;

type UploadFileOptions = {
  folder?: UploadFolder;
  acl?: ObjectCannedACL;
  cacheControl?: string;
  metadata?: Record<string, string>;
  maxSizeBytes?: number;
  forceDownload?: boolean;
  fileName?: string;
};

type SignedUploadOptions = {
  folder?: UploadFolder;
  contentType: string;
  fileName?: string;
  expiresIn?: number;
  maxSizeBytes?: number;
  metadata?: Record<string, string>;
};

type UploadedFileResult = {
  key: string;
  url: string;
  bucket: string;
  region: string;
  contentType: string;
  size: number;
  originalName: string;
  etag?: string;
};

type AllowedFileConfig = {
  extensions: string[];
  maxSizeBytes: number;
};

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || "";
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY || "";
const AWS_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET || "";
const AWS_ENDPOINT = process.env.AWS_S3_ENDPOINT || "";
const AWS_PUBLIC_BASE_URL = process.env.AWS_PUBLIC_BASE_URL || process.env.CLOUDFRONT_URL || "";
const AWS_FORCE_PATH_STYLE = process.env.AWS_S3_FORCE_PATH_STYLE === "true";
const DEFAULT_MAX_SIZE_BYTES = Number(process.env.MAX_UPLOAD_SIZE_BYTES || 1024 * 1024 * 100);

if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_BUCKET) {
  throw new Error("Missing AWS S3 environment variables");
}

export const s3 = new S3Client({
  region: AWS_REGION,
  endpoint: AWS_ENDPOINT || undefined,
  forcePathStyle: AWS_FORCE_PATH_STYLE || !!AWS_ENDPOINT,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

const allowedMimeTypes: Record<string, AllowedFileConfig> = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], maxSizeBytes: 15 * 1024 * 1024 },
  "image/png": { extensions: [".png"], maxSizeBytes: 15 * 1024 * 1024 },
  "image/webp": { extensions: [".webp"], maxSizeBytes: 15 * 1024 * 1024 },
  "image/gif": { extensions: [".gif"], maxSizeBytes: 15 * 1024 * 1024 },
  "video/mp4": { extensions: [".mp4"], maxSizeBytes: 500 * 1024 * 1024 },
  "video/webm": { extensions: [".webm"], maxSizeBytes: 500 * 1024 * 1024 },
  "video/quicktime": { extensions: [".mov"], maxSizeBytes: 500 * 1024 * 1024 },
  "audio/mpeg": { extensions: [".mp3"], maxSizeBytes: 50 * 1024 * 1024 },
  "audio/mp4": { extensions: [".m4a"], maxSizeBytes: 50 * 1024 * 1024 },
  "audio/wav": { extensions: [".wav"], maxSizeBytes: 50 * 1024 * 1024 },
  "audio/webm": { extensions: [".webm"], maxSizeBytes: 50 * 1024 * 1024 },
  "application/pdf": { extensions: [".pdf"], maxSizeBytes: 50 * 1024 * 1024 }
};

const extensionByMime: Record<string, string> = Object.fromEntries(
  Object.entries(allowedMimeTypes).map(([mime, config]) => [mime, config.extensions[0]])
);

const normalizeContentType = (contentType?: string) => String(contentType || "").split(";")[0].trim().toLowerCase();

const sanitizeFolder = (folder?: string) => {
  const value = String(folder || "uploads")
    .replace(/\\/g, "/")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");

  return value || "uploads";
};

const sanitizeFileName = (filename?: string) => {
  const parsed = path.parse(String(filename || "file"));
  const base = parsed.name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);

  return base || "file";
};

const getExtension = (fileName?: string, contentType?: string) => {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const mime = normalizeContentType(contentType);
  const config = allowedMimeTypes[mime];

  if (config?.extensions.includes(ext)) return ext;

  return extensionByMime[mime] || ext || ".bin";
};

const assertAllowedFile = (contentType: string, size: number, fileName?: string, maxSizeBytes?: number) => {
  const mime = normalizeContentType(contentType);
  const config = allowedMimeTypes[mime];

  if (!config) throw new Error("Unsupported file type");

  const ext = path.extname(String(fileName || "")).toLowerCase();

  if (ext && !config.extensions.includes(ext)) {
    throw new Error("File extension does not match content type");
  }

  const allowedSize = Math.min(maxSizeBytes || config.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES, config.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES);

  if (!Number.isFinite(size) || size <= 0) throw new Error("Invalid file size");
  if (size > allowedSize) throw new Error("File too large");

  return {
    mime,
    allowedSize
  };
};

const createKey = (folder: string, originalName?: string, contentType?: string) => {
  const safeFolder = sanitizeFolder(folder);
  const safeName = sanitizeFileName(originalName);
  const ext = getExtension(originalName, contentType);
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const random = crypto.randomBytes(8).toString("hex");

  return `${safeFolder}/${yyyy}/${mm}/${dd}/${uuid()}_${random}_${safeName}${ext}`;
};

const encodeKeyForUrl = (key: string) => key.split("/").map(part => encodeURIComponent(part)).join("/");

export const getPublicUrl = (key: string) => {
  const cleanKey = String(key || "").replace(/^\/+/, "");

  if (!cleanKey) throw new Error("S3 key is required");

  if (AWS_PUBLIC_BASE_URL) {
    return `${AWS_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${encodeKeyForUrl(cleanKey)}`;
  }

  if (AWS_ENDPOINT) {
    return `${AWS_ENDPOINT.replace(/\/+$/, "")}/${AWS_BUCKET}/${encodeKeyForUrl(cleanKey)}`;
  }

  return `https://${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeKeyForUrl(cleanKey)}`;
};

export const getS3KeyFromUrl = (url: string) => {
  const value = String(url || "").trim();

  if (!value) return null;

  try {
    const parsed = new URL(value);
    const pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));

    if (AWS_PUBLIC_BASE_URL && value.startsWith(AWS_PUBLIC_BASE_URL)) {
      return pathname;
    }

    if (parsed.hostname === `${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com`) {
      return pathname;
    }

    if (pathname.startsWith(`${AWS_BUCKET}/`)) {
      return pathname.slice(AWS_BUCKET.length + 1);
    }

    return pathname || null;
  } catch {
    return value.replace(/^\/+/, "") || null;
  }
};

export const uploadFile = async (
  file: Express.Multer.File,
  folder: UploadFolder = "uploads",
  options: UploadFileOptions = {}
): Promise<string> => {
  const result = await uploadFileDetailed(file, { ...options, folder });
  return result.url;
};

export const uploadFileDetailed = async (
  file: Express.Multer.File,
  options: UploadFileOptions = {}
): Promise<UploadedFileResult> => {
  if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
    throw new Error("No file uploaded");
  }

  const contentType = normalizeContentType(file.mimetype);
  const originalName = options.fileName || file.originalname || "file";
  const size = Number(file.size || file.buffer.length || 0);

  const validation = assertAllowedFile(contentType, size, originalName, options.maxSizeBytes);
  const key = createKey(options.folder || "uploads", originalName, validation.mime);

  const command = new PutObjectCommand({
    Bucket: AWS_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: validation.mime,
    ContentLength: size,
    CacheControl: options.cacheControl || "public, max-age=31536000, immutable",
    ContentDisposition: options.forceDownload ? `attachment; filename="${sanitizeFileName(originalName)}${getExtension(originalName, validation.mime)}"` : undefined,
    ACL: options.acl,
    Metadata: {
      originalName: Buffer.from(originalName).toString("base64url"),
      uploadedAt: new Date().toISOString(),
      ...Object.fromEntries(Object.entries(options.metadata || {}).map(([k, v]) => [k, String(v).slice(0, 1024)]))
    }
  });

  const uploaded = await s3.send(command);

  return {
    key,
    url: getPublicUrl(key),
    bucket: AWS_BUCKET,
    region: AWS_REGION,
    contentType: validation.mime,
    size,
    originalName,
    etag: uploaded.ETag
  };
};

export const uploadBuffer = async (
  buffer: Buffer,
  fileName: string,
  contentType: string,
  folder: UploadFolder = "uploads",
  options: UploadFileOptions = {}
): Promise<UploadedFileResult> => {
  const file = {
    buffer,
    originalname: fileName,
    mimetype: contentType,
    size: buffer.length
  } as Express.Multer.File;

  return uploadFileDetailed(file, { ...options, folder });
};

export const deleteFile = async (keyOrUrl: string) => {
  const key = getS3KeyFromUrl(keyOrUrl);

  if (!key) throw new Error("S3 key is required");

  await s3.send(
    new DeleteObjectCommand({
      Bucket: AWS_BUCKET,
      Key: key
    })
  );

  return {
    success: true,
    key
  };
};

export const fileExists = async (keyOrUrl: string) => {
  const key = getS3KeyFromUrl(keyOrUrl);

  if (!key) return false;

  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: AWS_BUCKET,
        Key: key
      })
    );

    return true;
  } catch {
    return false;
  }
};

export const getFileMetadata = async (keyOrUrl: string) => {
  const key = getS3KeyFromUrl(keyOrUrl);

  if (!key) throw new Error("S3 key is required");

  const result = await s3.send(
    new HeadObjectCommand({
      Bucket: AWS_BUCKET,
      Key: key
    })
  );

  return {
    key,
    contentType: result.ContentType || null,
    contentLength: result.ContentLength || 0,
    lastModified: result.LastModified || null,
    etag: result.ETag || null,
    metadata: result.Metadata || {}
  };
};

export const createSignedUploadUrl = async (options: SignedUploadOptions) => {
  const contentType = normalizeContentType(options.contentType);
  const fileName = options.fileName || "file";
  const config = allowedMimeTypes[contentType];

  if (!config) throw new Error("Unsupported file type");

  const maxSizeBytes = Math.min(options.maxSizeBytes || config.maxSizeBytes, config.maxSizeBytes);
  const key = createKey(options.folder || "uploads", fileName, contentType);

  const command = new PutObjectCommand({
    Bucket: AWS_BUCKET,
    Key: key,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
    Metadata: {
      originalName: Buffer.from(fileName).toString("base64url"),
      uploadedAt: new Date().toISOString(),
      ...Object.fromEntries(Object.entries(options.metadata || {}).map(([k, v]) => [k, String(v).slice(0, 1024)]))
    }
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: Math.max(60, Math.min(options.expiresIn || 900, 3600))
  });

  return {
    uploadUrl,
    key,
    url: getPublicUrl(key),
    bucket: AWS_BUCKET,
    region: AWS_REGION,
    contentType,
    maxSizeBytes
  };
};

export const createSignedReadUrl = async (keyOrUrl: string, expiresIn = 900) => {
  const key = getS3KeyFromUrl(keyOrUrl);

  if (!key) throw new Error("S3 key is required");

  const command = new GetObjectCommand({
    Bucket: AWS_BUCKET,
    Key: key
  });

  return getSignedUrl(s3, command, {
    expiresIn: Math.max(60, Math.min(expiresIn, 86400))
  });
};

export const isAllowedMimeType = (mimeType: string) => {
  return Boolean(allowedMimeTypes[normalizeContentType(mimeType)]);
};

export const getAllowedMimeTypes = () => Object.keys(allowedMimeTypes);

export const getUploadLimits = () =>
  Object.fromEntries(
    Object.entries(allowedMimeTypes).map(([mime, config]) => [
      mime,
      {
        extensions: config.extensions,
        maxSizeBytes: config.maxSizeBytes
      }
    ])
  );
