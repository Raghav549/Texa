import { Job } from "bullmq";
import path from "path";
import fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import axios from "axios";
import { processVideo, optimizeImage, generateImageVariants, getMediaMetadata } from "../services/media/processor";
import { uploadToS3 } from "../services/storage/s3";
import { deleteLocalFiles } from "../utils/media";
import { prisma } from "../config/db";

type MediaEntityType = "reel" | "story" | "product" | "avatar" | "banner" | "message" | "store" | "other";
type MediaJobName = "process" | "thumbnail" | "transcode" | "cleanup";
type ProcessingStatus = "queued" | "processing" | "completed" | "failed";

interface MediaWorkerJobData {
  itemId?: string;
  reelId?: string;
  storyId?: string;
  productId?: string;
  storeId?: string;
  messageId?: string;
  userId: string;
  type?: MediaEntityType;
  inputPath?: string;
  inputUrl?: string;
  outputDir?: string;
  mimeType?: string;
  originalName?: string;
  metadata?: Record<string, any>;
}

interface UploadedMediaResult {
  videoUrl?: string;
  imageUrl?: string;
  mediaUrl?: string;
  hlsUrl?: string;
  thumbnailUrl?: string;
  posterUrl?: string;
  previewUrl?: string;
  blurhash?: string;
  metadata?: Record<string, any>;
  variants?: Record<string, string>;
  mp4?: string;
  hls?: string;
  thumbnail?: string;
  poster?: string;
  preview?: string;
  optimized?: string;
  large?: string;
  medium?: string;
  small?: string;
  thumb?: string;
}

const DEFAULT_OUTPUT_DIR = process.env.MEDIA_OUTPUT_DIR || path.join(os.tmpdir(), "texa", "media");
const DOWNLOAD_TIMEOUT = 1000 * 60 * 3;
const MAX_DOWNLOAD_BYTES = Number(process.env.MEDIA_MAX_DOWNLOAD_BYTES || 1024 * 1024 * 700);

function getItemId(data: MediaWorkerJobData) {
  return data.itemId || data.reelId || data.storyId || data.productId || data.storeId || data.messageId;
}

function getEntityType(data: MediaWorkerJobData): MediaEntityType {
  if (data.type) return data.type;
  if (data.reelId) return "reel";
  if (data.storyId) return "story";
  if (data.productId) return "product";
  if (data.storeId) return "store";
  if (data.messageId) return "message";
  return "other";
}

function getStoragePrefix(type: MediaEntityType, itemId: string) {
  if (type === "reel") return `reels/${itemId}`;
  if (type === "story") return `stories/${itemId}`;
  if (type === "product") return `products/${itemId}`;
  if (type === "avatar") return `users/avatars/${itemId}`;
  if (type === "banner") return `users/banners/${itemId}`;
  if (type === "store") return `stores/${itemId}`;
  if (type === "message") return `messages/${itemId}`;
  return `media/${type}/${itemId}`;
}

function inferExtension(mimeType?: string, fallbackName?: string) {
  const ext = fallbackName ? path.extname(fallbackName).replace(".", "").toLowerCase() : "";
  if (ext) return ext;
  if (!mimeType) return "bin";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return mimeType.split("/")[1]?.split(";")[0] || "bin";
}

function isImageJob(data: MediaWorkerJobData) {
  return Boolean(data.mimeType?.startsWith("image/") || data.metadata?.mediaKind === "image" || data.metadata?.kind === "image");
}

function isVideoJob(data: MediaWorkerJobData) {
  return Boolean(data.mimeType?.startsWith("video/") || data.metadata?.mediaKind === "video" || data.metadata?.kind === "video");
}

function compact<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}

function mergeJson(base: any, next: any) {
  return {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
    ...(next && typeof next === "object" && !Array.isArray(next) ? next : {})
  };
}

async function safeExists(filePath?: string) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function downloadInputFile(data: MediaWorkerJobData, itemId: string, type: MediaEntityType) {
  if (data.inputPath && await safeExists(data.inputPath)) return data.inputPath;
  if (!data.inputUrl) return data.inputPath;

  const outputDir = await ensureDir(path.join(DEFAULT_OUTPUT_DIR, "downloads", type, itemId));
  const ext = inferExtension(data.mimeType, data.originalName);
  const filePath = path.join(outputDir, `${Date.now()}_${crypto.randomBytes(10).toString("hex")}.${ext}`);

  const response = await axios.get(data.inputUrl, {
    responseType: "arraybuffer",
    timeout: DOWNLOAD_TIMEOUT,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    validateStatus: status => status >= 200 && status < 300
  });

  await fs.writeFile(filePath, Buffer.from(response.data));
  return filePath;
}

async function emitToUser(userId: string | undefined, event: string, payload: Record<string, any>) {
  if (!userId) return;
  try {
    const { io } = await import("../app");
    io.to(`user:${userId}`).emit(event, payload);
  } catch {}
}

async function emitToStore(storeId: string | undefined, event: string, payload: Record<string, any>) {
  if (!storeId) return;
  try {
    const { io } = await import("../app");
    io.to(`store:${storeId}`).emit(event, payload);
  } catch {}
}

async function emitProgress(data: MediaWorkerJobData, stage: string, progress: number, extra: Record<string, any> = {}) {
  const itemId = getItemId(data);
  const type = getEntityType(data);
  const payload = {
    itemId,
    type,
    stage,
    progress,
    ...extra
  };

  await emitToUser(data.userId, "media:progress", payload);
  await emitToUser(data.userId, `${type}:media_progress`, payload);
  await emitToStore(data.storeId, "store:media_progress", payload);
}

async function updateJobProgress(job: Job<MediaWorkerJobData>, data: MediaWorkerJobData, stage: string, progress: number, extra: Record<string, any> = {}) {
  await job.updateProgress({
    stage,
    progress,
    ...extra
  });
  await emitProgress(data, stage, progress, extra);
}

async function updateProcessingStatus(data: MediaWorkerJobData, status: ProcessingStatus, extra: Record<string, any> = {}) {
  const type = getEntityType(data);
  const itemId = getItemId(data);
  if (!itemId) return;

  try {
    if (type === "reel") {
      await prisma.reel.update({
        where: { id: itemId },
        data: compact({
          encodingStatus: status,
          videoUrl: extra.videoUrl,
          hlsUrl: extra.hlsUrl,
          thumbnailUrl: extra.thumbnailUrl,
          blurhash: extra.blurhash,
          duration: extra.duration,
          width: extra.width,
          height: extra.height
        }) as any
      });
      return;
    }

    if (type === "story") {
      await prisma.story.update({
        where: { id: itemId },
        data: compact({
          processingStatus: status,
          mediaUrl: extra.mediaUrl || extra.videoUrl || extra.imageUrl,
          thumbnailUrl: extra.thumbnailUrl,
          blurhash: extra.blurhash,
          duration: extra.duration
        }) as any
      });
      return;
    }

    if (type === "product") {
      const product = await prisma.product.findUnique({
        where: { id: itemId },
        select: { attributes: true, primaryMediaUrl: true }
      }).catch(() => null);

      const mediaUrl = extra.imageUrl || extra.videoUrl || extra.mediaUrl;
      const updateData: Record<string, any> = {};

      if (mediaUrl) updateData.mediaUrls = { push: mediaUrl };
      if (mediaUrl && !product?.primaryMediaUrl) updateData.primaryMediaUrl = extra.thumbnailUrl || mediaUrl;
      if (extra.metadata || extra.video || extra.variants) {
        updateData.attributes = mergeJson(product?.attributes, {
          mediaMetadata: extra.metadata,
          video: extra.video,
          variants: extra.variants,
          processingStatus: status,
          processingError: extra.processingError
        });
      }

      if (Object.keys(updateData).length) {
        await prisma.product.update({
          where: { id: itemId },
          data: updateData as any
        });
      }
      return;
    }

    if (type === "store") {
      const updateData: Record<string, any> = {};
      const mediaUrl = extra.imageUrl || extra.mediaUrl || extra.videoUrl;
      if (mediaUrl && data.metadata?.kind === "logo") updateData.logoUrl = mediaUrl;
      if (mediaUrl && data.metadata?.kind !== "logo") updateData.bannerUrl = mediaUrl;
      if (Object.keys(updateData).length) {
        await prisma.store.update({
          where: { id: itemId },
          data: updateData as any
        });
      }
      return;
    }

    if (type === "avatar" && extra.imageUrl) {
      await prisma.user.update({
        where: { id: data.userId },
        data: { avatarUrl: extra.imageUrl }
      });
      return;
    }

    if (type === "banner" && extra.imageUrl) {
      await prisma.user.update({
        where: { id: data.userId },
        data: { bannerUrl: extra.imageUrl } as any
      });
      return;
    }

    if (type === "message" && data.messageId) {
      await prisma.message.update({
        where: { id: data.messageId },
        data: compact({
          mediaUrl: extra.mediaUrl || extra.videoUrl || extra.imageUrl,
          metadata: mergeJson(data.metadata, {
            media: extra.metadata,
            thumbnailUrl: extra.thumbnailUrl,
            blurhash: extra.blurhash,
            processingStatus: status,
            processingError: extra.processingError
          })
        }) as any
      }).catch(() => null);
    }
  } catch {}
}

async function markFailed(data: MediaWorkerJobData, error: any) {
  const itemId = getItemId(data);
  const type = getEntityType(data);
  const message = error?.message || "Media processing failed";

  await updateProcessingStatus(data, "failed", {
    encodingStatus: "failed",
    processingStatus: "failed",
    processingError: message
  });

  await emitToUser(data.userId, `${type}:media_failed`, {
    itemId,
    type,
    error: message
  });

  await emitToUser(data.userId, "media:failed", {
    itemId,
    type,
    error: message
  });

  await emitToStore(data.storeId, "store:media_failed", {
    itemId,
    type,
    error: message
  });
}

function normalizeVideoUpload(uploaded: UploadedMediaResult, processed: any, metadata: Record<string, any>) {
  const videoUrl = uploaded.videoUrl || uploaded.mediaUrl || uploaded.mp4 || uploaded.optimized || processed.videoUrl || processed.mp4;
  const hlsUrl = uploaded.hlsUrl || uploaded.hls || processed.hlsUrl || processed.hls || processed.masterPlaylist;
  const thumbnailUrl = uploaded.thumbnailUrl || uploaded.thumbnail || processed.thumbnailUrl || processed.thumbnail;
  const posterUrl = uploaded.posterUrl || uploaded.poster || processed.posterUrl || processed.poster || thumbnailUrl;
  const previewUrl = uploaded.previewUrl || uploaded.preview || processed.previewUrl || processed.preview;

  return {
    videoUrl,
    mediaUrl: videoUrl,
    hlsUrl,
    thumbnailUrl,
    posterUrl,
    previewUrl,
    blurhash: uploaded.blurhash || processed.blurhash,
    metadata: {
      ...metadata,
      ...(processed.metadata || {}),
      ...(uploaded.metadata || {})
    },
    video: {
      videoUrl,
      hlsUrl,
      thumbnailUrl,
      posterUrl,
      previewUrl,
      blurhash: uploaded.blurhash || processed.blurhash
    }
  };
}

function normalizeImageUpload(uploaded: UploadedMediaResult, optimized: any) {
  const variants = uploaded.variants || compact({
    thumb: uploaded.thumb,
    small: uploaded.small,
    medium: uploaded.medium,
    large: uploaded.large
  });

  const imageUrl =
    uploaded.imageUrl ||
    uploaded.mediaUrl ||
    uploaded.optimized ||
    uploaded.large ||
    variants.large ||
    variants.medium ||
    variants.small ||
    variants.thumb ||
    uploaded.thumbnailUrl ||
    uploaded.posterUrl;

  return {
    imageUrl,
    mediaUrl: imageUrl,
    thumbnailUrl: variants.thumb || uploaded.thumbnailUrl || imageUrl,
    variants,
    blurhash: uploaded.blurhash || optimized?.blurhash,
    metadata: {
      ...(optimized?.metadata || {}),
      ...(uploaded.metadata || {})
    }
  };
}

async function cleanupProcessedFiles(files: Array<string | undefined | null>) {
  const filtered = files.filter((file): file is string => Boolean(file));
  if (!filtered.length) return;
  try {
    await deleteLocalFiles(filtered);
  } catch {}
}

async function processVideoJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  const itemId = getItemId(data);
  const type = getEntityType(data);

  if (!itemId) throw new Error("Media job missing itemId");
  if (!data.userId) throw new Error("Media job missing userId");

  const inputPath = await downloadInputFile(data, itemId, type);
  if (!inputPath) throw new Error("Media job missing inputPath");
  if (!(await safeExists(inputPath))) throw new Error(`Input file not found: ${inputPath}`);

  const outputDir = data.outputDir || path.join(DEFAULT_OUTPUT_DIR, type, itemId);
  await ensureDir(outputDir);

  await updateProcessingStatus(data, "processing");
  await updateJobProgress(job, data, "metadata", 5);

  const metadata = await getMediaMetadata(inputPath);
  await updateJobProgress(job, data, "processing", 15, { metadata });

  const processed = await processVideo(inputPath, outputDir, {
    maxDurationSeconds: type === "story" ? 15 : type === "reel" ? 180 : 600,
    thumbnailAtPercent: 0.15,
    hlsSegmentSeconds: 4,
    crf: 23,
    preset: "medium",
    keepOriginalAspect: true
  } as any);

  await updateJobProgress(job, data, "uploading", 75);

  const prefix = getStoragePrefix(type, itemId);
  const uploaded = await uploadToS3(processed, prefix) as UploadedMediaResult;
  const payload = normalizeVideoUpload(uploaded, processed, metadata || {});

  const duration = payload.metadata?.duration ? Number(payload.metadata.duration) : undefined;
  const width = payload.metadata?.width ? Number(payload.metadata.width) : undefined;
  const height = payload.metadata?.height ? Number(payload.metadata.height) : undefined;

  await updateProcessingStatus(data, "completed", {
    ...payload,
    duration: type === "story" ? Math.min(Math.ceil(duration || 15), 15) : duration,
    width,
    height,
    encodingStatus: "completed",
    processingStatus: "completed"
  });

  await updateJobProgress(job, data, "completed", 100);

  await emitToUser(data.userId, `${type}:media_ready`, {
    itemId,
    type,
    ...payload
  });

  await emitToUser(data.userId, "media:ready", {
    itemId,
    type,
    ...payload
  });

  await emitToStore(data.storeId, "store:media_ready", {
    itemId,
    type,
    ...payload
  });

  await cleanupProcessedFiles([
    inputPath,
    processed.thumbnail,
    processed.poster,
    processed.preview,
    processed.mp4,
    processed.hls,
    processed.masterPlaylist,
    processed.outputDir
  ]);

  return {
    itemId,
    type,
    ...payload
  };
}

async function processImageJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  const itemId = getItemId(data);
  const type = getEntityType(data);

  if (!itemId) throw new Error("Image job missing itemId");
  if (!data.userId) throw new Error("Image job missing userId");

  const inputPath = await downloadInputFile(data, itemId, type);
  if (!inputPath) throw new Error("Image job missing inputPath");
  if (!(await safeExists(inputPath))) throw new Error(`Input file not found: ${inputPath}`);

  await updateProcessingStatus(data, "processing");
  await updateJobProgress(job, data, "reading", 10);

  const buffer = await fs.readFile(inputPath);

  await updateJobProgress(job, data, "optimizing", 35);

  const optimized = await optimizeImage(buffer, "webp");
  const variants = await generateImageVariants(buffer, {
    format: "webp",
    sizes: {
      thumb: 160,
      small: 360,
      medium: 720,
      large: 1200
    }
  } as any);

  await updateJobProgress(job, data, "uploading", 70);

  const prefix = getStoragePrefix(type, itemId);
  const uploaded = await uploadToS3({
    optimized,
    variants
  }, prefix) as UploadedMediaResult;

  const payload = normalizeImageUpload(uploaded, optimized);

  await updateProcessingStatus(data, "completed", {
    ...payload,
    processingStatus: "completed"
  });

  await updateJobProgress(job, data, "completed", 100);

  await emitToUser(data.userId, `${type}:media_ready`, {
    itemId,
    type,
    ...payload
  });

  await emitToUser(data.userId, "media:ready", {
    itemId,
    type,
    ...payload
  });

  await emitToStore(data.storeId, "store:media_ready", {
    itemId,
    type,
    ...payload
  });

  await cleanupProcessedFiles([inputPath]);

  return {
    itemId,
    type,
    ...payload
  };
}

async function cleanupMediaJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  const files = data.metadata?.files || [];
  const dirs = data.metadata?.dirs || [];
  const targets = [...(Array.isArray(files) ? files : []), ...(Array.isArray(dirs) ? dirs : [])].filter(Boolean);

  if (!targets.length) {
    const itemId = getItemId(data);
    const type = getEntityType(data);
    if (!itemId) return { cleaned: 0 };
    const dir = path.join(DEFAULT_OUTPUT_DIR, type, itemId);
    if (!(await safeExists(dir))) return { cleaned: 0 };
    await cleanupProcessedFiles([dir]);
    return { cleaned: 1 };
  }

  await cleanupProcessedFiles(targets);
  return { cleaned: targets.length };
}

async function thumbnailJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  if (isImageJob(data)) return processImageJob(job);
  return processVideoJob(job);
}

async function transcodeJob(job: Job<MediaWorkerJobData>) {
  return processVideoJob(job);
}

export async function processMediaWorker(job: Job<MediaWorkerJobData, any, MediaJobName>) {
  const data = job.data;
  const itemId = getItemId(data);
  const type = getEntityType(data);

  try {
    if (!data.userId) throw new Error("Media worker requires userId");

    await emitToUser(data.userId, "media:started", {
      itemId,
      type,
      jobId: job.id,
      jobName: job.name
    });

    if (job.name === "cleanup") return await cleanupMediaJob(job);
    if (job.name === "thumbnail") return await thumbnailJob(job);
    if (job.name === "transcode") return await transcodeJob(job);
    if (isImageJob(data) && !isVideoJob(data)) return await processImageJob(job);

    return await processVideoJob(job);
  } catch (error: any) {
    await markFailed(data, error);
    throw error;
  }
}
