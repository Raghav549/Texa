import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  type PutObjectCommandInput
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import mime from 'mime-types';

export type UploadInputValue =
  | string
  | Buffer
  | Uint8Array
  | {
      path?: string;
      buffer?: Buffer | Uint8Array;
      originalname?: string;
      filename?: string;
      mimetype?: string;
      contentType?: string;
      key?: string;
      metadata?: Record<string, string | number | boolean | null | undefined>;
      size?: number;
    };

export type UploadOptions = {
  folder?: string;
  acl?: PutObjectCommandInput['ACL'];
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  publicRead?: boolean;
  preserveName?: boolean;
  prefixKey?: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
  maxSizeBytes?: number;
  allowedMimeTypes?: string[];
  allowedExtensions?: string[];
  private?: boolean;
};

export type UploadedFile = {
  key: string;
  url: string;
  publicUrl: string;
  bucket: string;
  contentType: string;
  size?: number;
  etag?: string;
};

export type PresignedUploadResult = {
  key: string;
  url: string;
  publicUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresIn: number;
};

const required = (value: string | undefined, name: string) => {
  if (!value || value.trim() === '') throw new Error(`${name} is missing`);
  return value.trim();
};

const AWS_REGION = required(process.env.AWS_REGION || process.env.S3_REGION, 'AWS_REGION');
const AWS_BUCKET = required(process.env.AWS_BUCKET || process.env.S3_BUCKET, 'AWS_BUCKET');
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN?.replace(/\/+$/, '');
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '');
const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined;
const DEFAULT_MAX_FILE_SIZE = Number(process.env.S3_MAX_FILE_SIZE_BYTES || 250 * 1024 * 1024);
const DEFAULT_CACHE_CONTROL = process.env.S3_DEFAULT_CACHE_CONTROL || 'public, max-age=31536000, immutable';
const DEFAULT_PRIVATE_CACHE_CONTROL = process.env.S3_PRIVATE_CACHE_CONTROL || 'private, max-age=0, no-cache';
const DEFAULT_SSE = process.env.S3_SSE || 'AES256';

export const s3 = new S3Client({
  region: AWS_REGION,
  credentials:
    AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY
        }
      : undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || Boolean(S3_ENDPOINT),
  endpoint: S3_ENDPOINT,
  maxAttempts: Number(process.env.S3_MAX_ATTEMPTS || 3)
});

const safeSegment = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\\/g, '/')
    .replace(/[^\w.\-\/]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/\.\./g, '')
    .toLowerCase();

const normalizeFolder = (folder = 'uploads') =>
  safeSegment(folder)
    .replace(/^\/+|\/+$/g, '')
    .slice(0, 180) || 'uploads';

const normalizeKey = (key: string) =>
  safeSegment(key)
    .replace(/^\/+/, '')
    .replace(/\/+$/g, '')
    .slice(0, 1024);

const normalizeMetadata = (metadata?: Record<string, string | number | boolean | null | undefined>) => {
  const clean: Record<string, string> = {};
  if (!metadata) return clean;

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    const safeKey = safeSegment(key).replace(/\//g, '-').slice(0, 64);
    if (!safeKey) continue;
    clean[safeKey] = String(value).slice(0, 512);
  }

  return clean;
};

const buildTagging = (tags?: Record<string, string | number | boolean | null | undefined>) => {
  if (!tags) return undefined;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    const safeKey = safeSegment(key).replace(/\//g, '-').slice(0, 64);
    if (!safeKey) continue;
    params.append(safeKey, String(value).slice(0, 256));
  }

  const output = params.toString();
  return output || undefined;
};

const inferContentType = (filenameOrPath: string, fallback?: string) => {
  if (fallback && fallback.trim()) return fallback.trim();
  const detected = mime.lookup(filenameOrPath);
  return detected || 'application/octet-stream';
};

const extFromContentType = (contentType: string) => {
  const ext = mime.extension(contentType);
  return ext ? `.${ext}` : '';
};

const getPublicUrl = (key: string) => {
  const encodedKey = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  if (CLOUDFRONT_DOMAIN) return `${CLOUDFRONT_DOMAIN}/${encodedKey}`;
  if (S3_PUBLIC_BASE_URL) return `${S3_PUBLIC_BASE_URL}/${encodedKey}`;
  if (S3_ENDPOINT && S3_PUBLIC_BASE_URL) return `${S3_PUBLIC_BASE_URL}/${encodedKey}`;
  return `https://${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodedKey}`;
};

const fileExists = async (filePath: string) => {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const assertUploadPolicy = (filename: string, contentType: string, size: number | undefined, options: UploadOptions) => {
  const maxSize = Number(options.maxSizeBytes || DEFAULT_MAX_FILE_SIZE);

  if (size !== undefined && size > maxSize) {
    throw new Error(`File size exceeds ${maxSize} bytes`);
  }

  if (options.allowedMimeTypes?.length && !options.allowedMimeTypes.includes(contentType)) {
    throw new Error(`File type ${contentType} is not allowed`);
  }

  if (options.allowedExtensions?.length) {
    const ext = path.extname(filename).replace('.', '').toLowerCase();
    const allowed = options.allowedExtensions.map((item) => item.replace('.', '').toLowerCase());
    if (!allowed.includes(ext)) throw new Error(`File extension .${ext} is not allowed`);
  }
};

const readUploadInput = async (input: UploadInputValue) => {
  if (typeof input === 'string') {
    if (!(await fileExists(input))) throw new Error(`File not found: ${input}`);

    const body = fs.createReadStream(input);
    const stat = await fs.promises.stat(input);
    const filename = path.basename(input);
    const contentType = inferContentType(filename);

    return { body, filename, contentType, size: stat.size };
  }

  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buffer = Buffer.from(input);

    return {
      body: buffer,
      filename: `${uuid()}`,
      contentType: 'application/octet-stream',
      size: buffer.length
    };
  }

  if (input?.path) {
    if (!(await fileExists(input.path))) throw new Error(`File not found: ${input.path}`);

    const body = fs.createReadStream(input.path);
    const stat = await fs.promises.stat(input.path);
    const filename = input.originalname || input.filename || path.basename(input.path);
    const contentType = inferContentType(filename, input.mimetype || input.contentType);

    return { body, filename, contentType, size: input.size || stat.size };
  }

  if (input?.buffer) {
    const buffer = Buffer.from(input.buffer);
    const fallbackContentType = input.mimetype || input.contentType || 'application/octet-stream';
    const filename = input.originalname || input.filename || input.key || `${uuid()}${extFromContentType(fallbackContentType)}`;
    const contentType = inferContentType(filename, fallbackContentType);

    return { body: buffer, filename, contentType, size: input.size || buffer.length };
  }

  throw new Error('Invalid upload input');
};

const buildObjectKey = (input: UploadInputValue, filename: string, contentType: string, options: UploadOptions = {}) => {
  const folder = normalizeFolder(options.folder || 'uploads');

  if (typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) && input.key) {
    const key = normalizeKey(input.key);
    if (!key) throw new Error('Invalid object key');
    return key;
  }

  const ext = path.extname(filename) || extFromContentType(contentType);
  const baseName = path.basename(filename, path.extname(filename));
  const safeName = safeSegment(baseName).replace(/\//g, '-').slice(0, 90) || 'file';
  const id = options.preserveName ? `${Date.now()}-${crypto.randomBytes(6).toString('hex')}` : uuid();
  const prefix = options.prefixKey ? `${normalizeKey(options.prefixKey)}/` : '';

  return `${folder}/${prefix}${options.preserveName ? `${safeName}-${id}` : id}${ext.toLowerCase()}`;
};

export async function uploadFileToS3(input: UploadInputValue, options: UploadOptions = {}): Promise<UploadedFile> {
  const parsed = await readUploadInput(input);
  assertUploadPolicy(parsed.filename, parsed.contentType, parsed.size, options);

  const key = buildObjectKey(input, parsed.filename, parsed.contentType, options);
  const metadata = normalizeMetadata({
    ...options.metadata,
    ...(typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array) ? input.metadata : undefined),
    originalName: parsed.filename,
    contentHash: crypto.createHash('sha256').update(`${parsed.filename}:${parsed.size || 0}:${Date.now()}`).digest('hex').slice(0, 32)
  });

  const params: PutObjectCommandInput = {
    Bucket: AWS_BUCKET,
    Key: key,
    Body: parsed.body,
    ContentType: parsed.contentType,
    CacheControl: options.cacheControl || (options.private ? DEFAULT_PRIVATE_CACHE_CONTROL : DEFAULT_CACHE_CONTROL),
    ContentDisposition: options.contentDisposition,
    Metadata: metadata,
    Tagging: buildTagging(options.tags),
    ACL: options.private ? undefined : options.publicRead ? 'public-read' : options.acl,
    ServerSideEncryption: DEFAULT_SSE
  };

  const uploader = new Upload({
    client: s3,
    params,
    queueSize: Number(process.env.S3_UPLOAD_QUEUE_SIZE || 4),
    partSize: Number(process.env.S3_UPLOAD_PART_SIZE || 8 * 1024 * 1024),
    leavePartsOnError: false
  });

  const result = await uploader.done();
  const publicUrl = getPublicUrl(key);

  return {
    key,
    url: publicUrl,
    publicUrl,
    bucket: AWS_BUCKET,
    contentType: parsed.contentType,
    size: parsed.size,
    etag: result.ETag
  };
}

export async function uploadToS3(files: Record<string, UploadInputValue>, folder = 'uploads', options: UploadOptions = {}): Promise<Record<string, string>> {
  const entries = Object.entries(files || {});

  const uploaded = await Promise.all(
    entries.map(async ([name, file]) => {
      const result = await uploadFileToS3(file, { ...options, folder });
      return [name, result.url] as const;
    })
  );

  return Object.fromEntries(uploaded);
}

export async function uploadManyToS3(files: UploadInputValue[], folder = 'uploads', options: UploadOptions = {}): Promise<UploadedFile[]> {
  return Promise.all(files.map((file) => uploadFileToS3(file, { ...options, folder })));
}

export async function getPresignedUrl(key: string, expiresMin = 15) {
  const safeKey = normalizeKey(key);
  if (!safeKey) throw new Error('Invalid S3 key');

  const command = new GetObjectCommand({
    Bucket: AWS_BUCKET,
    Key: safeKey
  });

  return getSignedUrl(s3, command, {
    expiresIn: Math.max(60, Math.min(expiresMin * 60, 7 * 24 * 60 * 60))
  });
}

export async function getPresignedUploadUrl(
  key: string,
  contentType = 'application/octet-stream',
  expiresMin = 15,
  options: Pick<UploadOptions, 'cacheControl' | 'metadata' | 'tags' | 'private'> = {}
): Promise<PresignedUploadResult> {
  const safeKey = normalizeKey(key);
  if (!safeKey) throw new Error('Invalid S3 key');

  const expiresIn = Math.max(60, Math.min(expiresMin * 60, 7 * 24 * 60 * 60));
  const cacheControl = options.cacheControl || (options.private ? DEFAULT_PRIVATE_CACHE_CONTROL : DEFAULT_CACHE_CONTROL);

  const command = new PutObjectCommand({
    Bucket: AWS_BUCKET,
    Key: safeKey,
    ContentType: contentType,
    CacheControl: cacheControl,
    Metadata: normalizeMetadata(options.metadata),
    Tagging: buildTagging(options.tags),
    ServerSideEncryption: DEFAULT_SSE
  });

  return {
    key: safeKey,
    url: await getSignedUrl(s3, command, { expiresIn }),
    publicUrl: getPublicUrl(safeKey),
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    },
    expiresIn
  };
}

export async function deleteFromS3(key: string) {
  const safeKey = normalizeKey(key);
  if (!safeKey) throw new Error('Invalid S3 key');

  await s3.send(
    new DeleteObjectCommand({
      Bucket: AWS_BUCKET,
      Key: safeKey
    })
  );

  return { deleted: true, key: safeKey };
}

export async function deleteManyFromS3(keys: string[]) {
  const objects = [...new Set(keys.map(normalizeKey).filter(Boolean))].map((Key) => ({ Key }));

  if (objects.length === 0) return { deleted: 0, errors: [] as any[] };

  const chunks: { Key: string }[][] = [];
  for (let i = 0; i < objects.length; i += 1000) chunks.push(objects.slice(i, i + 1000));

  let deleted = 0;
  const errors: any[] = [];

  for (const chunk of chunks) {
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: AWS_BUCKET,
        Delete: {
          Objects: chunk,
          Quiet: true
        }
      })
    );

    deleted += chunk.length - (result.Errors?.length || 0);

    if (result.Errors?.length) {
      errors.push(...result.Errors);
    }
  }

  return { deleted, errors };
}

export async function objectExists(key: string) {
  const safeKey = normalizeKey(key);
  if (!safeKey) return false;

  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: AWS_BUCKET,
        Key: safeKey
      })
    );

    return true;
  } catch {
    return false;
  }
}

export async function getObjectMeta(key: string) {
  const safeKey = normalizeKey(key);
  if (!safeKey) throw new Error('Invalid S3 key');

  const result = await s3.send(
    new HeadObjectCommand({
      Bucket: AWS_BUCKET,
      Key: safeKey
    })
  );

  return {
    key: safeKey,
    bucket: AWS_BUCKET,
    contentType: result.ContentType,
    contentLength: result.ContentLength,
    etag: result.ETag,
    lastModified: result.LastModified,
    metadata: result.Metadata || {},
    url: getPublicUrl(safeKey),
    publicUrl: getPublicUrl(safeKey)
  };
}

export async function copyObjectInS3(
  sourceKey: string,
  destinationKey: string,
  options: Pick<UploadOptions, 'cacheControl' | 'metadata' | 'tags' | 'private'> = {}
) {
  const source = normalizeKey(sourceKey);
  const destination = normalizeKey(destinationKey);

  if (!source || !destination) throw new Error('Invalid S3 key');

  await s3.send(
    new CopyObjectCommand({
      Bucket: AWS_BUCKET,
      CopySource: `${AWS_BUCKET}/${encodeURIComponent(source).replace(/%2F/g, '/')}`,
      Key: destination,
      CacheControl: options.cacheControl || (options.private ? DEFAULT_PRIVATE_CACHE_CONTROL : DEFAULT_CACHE_CONTROL),
      Metadata: normalizeMetadata(options.metadata),
      MetadataDirective: options.metadata ? 'REPLACE' : 'COPY',
      Tagging: buildTagging(options.tags),
      TaggingDirective: options.tags ? 'REPLACE' : 'COPY',
      ServerSideEncryption: DEFAULT_SSE
    })
  );

  return {
    key: destination,
    url: getPublicUrl(destination),
    publicUrl: getPublicUrl(destination)
  };
}

export function getS3PublicUrl(key: string) {
  const safeKey = normalizeKey(key);
  if (!safeKey) throw new Error('Invalid S3 key');
  return getPublicUrl(safeKey);
}

export function extractS3KeyFromUrl(url: string) {
  if (!url) return '';

  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));

    if (CLOUDFRONT_DOMAIN && url.startsWith(CLOUDFRONT_DOMAIN)) return normalizeKey(pathname);
    if (S3_PUBLIC_BASE_URL && url.startsWith(S3_PUBLIC_BASE_URL)) return normalizeKey(pathname);

    const virtualHost = `${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
    const regionalHost = `s3.${AWS_REGION}.amazonaws.com`;
    const globalHost = 's3.amazonaws.com';

    if (parsed.hostname === virtualHost) return normalizeKey(pathname);

    if (parsed.hostname === regionalHost || parsed.hostname === globalHost) {
      const parts = pathname.split('/');
      if (parts[0] === AWS_BUCKET) return normalizeKey(parts.slice(1).join('/'));
      return normalizeKey(pathname);
    }

    return normalizeKey(pathname);
  } catch {
    return normalizeKey(url);
  }
}

export function buildS3Key(folder: string, filename: string, contentType = 'application/octet-stream', prefixKey?: string) {
  return buildObjectKey(
    {
      filename,
      contentType
    },
    filename,
    contentType,
    {
      folder,
      prefixKey
    }
  );
}

export function getStorageConfig() {
  return {
    bucket: AWS_BUCKET,
    region: AWS_REGION,
    endpoint: S3_ENDPOINT || null,
    publicBaseUrl: S3_PUBLIC_BASE_URL || null,
    cloudfrontDomain: CLOUDFRONT_DOMAIN || null,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || Boolean(S3_ENDPOINT)
  };
}
