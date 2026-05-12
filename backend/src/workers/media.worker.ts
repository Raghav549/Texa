import { Job } from 'bullmq';
import path from 'path';
import fs from 'fs/promises';
import { processVideo, optimizeImage, generateImageVariants, getMediaMetadata } from '../services/media/processor';
import { uploadToS3, deleteLocalFiles } from '../services/storage/s3';
import { prisma } from '../config/db';

type MediaEntityType = 'reel' | 'story' | 'product' | 'avatar' | 'banner' | 'message' | 'store' | 'other';
type MediaJobName = 'process' | 'thumbnail' | 'transcode' | 'cleanup';

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
  hlsUrl?: string;
  thumbnailUrl?: string;
  posterUrl?: string;
  previewUrl?: string;
  blurhash?: string;
  metadata?: Record<string, any>;
  variants?: Record<string, string>;
}

const DEFAULT_OUTPUT_DIR = process.env.MEDIA_OUTPUT_DIR || '/tmp/texa/media';

function getItemId(data: MediaWorkerJobData) {
  return data.itemId || data.reelId || data.storyId || data.productId || data.storeId || data.messageId;
}

function getEntityType(data: MediaWorkerJobData): MediaEntityType {
  if (data.type) return data.type;
  if (data.reelId) return 'reel';
  if (data.storyId) return 'story';
  if (data.productId) return 'product';
  if (data.storeId) return 'store';
  if (data.messageId) return 'message';
  return 'other';
}

function getStoragePrefix(type: MediaEntityType, itemId: string) {
  if (type === 'reel') return `reels/${itemId}`;
  if (type === 'story') return `stories/${itemId}`;
  if (type === 'product') return `products/${itemId}`;
  if (type === 'avatar') return `users/avatars/${itemId}`;
  if (type === 'banner') return `users/banners/${itemId}`;
  if (type === 'store') return `stores/${itemId}`;
  if (type === 'message') return `messages/${itemId}`;
  return `media/${type}/${itemId}`;
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

async function emitToUser(userId: string, event: string, payload: Record<string, any>) {
  try {
    const { io } = await import('../app');
    io.to(`user:${userId}`).emit(event, payload);
  } catch {}
}

async function emitToStore(storeId: string | undefined, event: string, payload: Record<string, any>) {
  if (!storeId) return;
  try {
    const { io } = await import('../app');
    io.to(`store:${storeId}`).emit(event, payload);
  } catch {}
}

async function updateProcessingStatus(data: MediaWorkerJobData, status: 'queued' | 'processing' | 'completed' | 'failed', extra: Record<string, any> = {}) {
  const type = getEntityType(data);
  const itemId = getItemId(data);
  if (!itemId) return;

  if (type === 'reel') {
    await prisma.reel.update({
      where: { id: itemId },
      data: {
        encodingStatus: status,
        ...extra
      }
    });
    return;
  }

  if (type === 'story') {
    await prisma.story.update({
      where: { id: itemId },
      data: {
        processingStatus: status,
        ...extra
      }
    });
    return;
  }

  if (type === 'product') {
    const updateData: any = {};
    if (extra.videoUrl) updateData.mediaUrls = { push: extra.videoUrl };
    if (extra.thumbnailUrl && !extra.primaryMediaUrl) updateData.primaryMediaUrl = extra.thumbnailUrl;
    if (extra.metadata) updateData.attributes = { mediaMetadata: extra.metadata };
    if (Object.keys(updateData).length) {
      await prisma.product.update({
        where: { id: itemId },
        data: updateData
      });
    }
    return;
  }

  if (type === 'store') {
    const updateData: any = {};
    if (extra.logoUrl) updateData.logoUrl = extra.logoUrl;
    if (extra.bannerUrl) updateData.bannerUrl = extra.bannerUrl;
    if (Object.keys(updateData).length) {
      await prisma.store.update({
        where: { id: itemId },
        data: updateData
      });
    }
  }
}

async function processVideoJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  const itemId = getItemId(data);
  const type = getEntityType(data);

  if (!itemId) throw new Error('Media job missing itemId');
  if (!data.userId) throw new Error('Media job missing userId');
  if (!data.inputPath) throw new Error('Media job missing inputPath');
  if (!(await safeExists(data.inputPath))) throw new Error(`Input file not found: ${data.inputPath}`);

  const outputDir = data.outputDir || path.join(DEFAULT_OUTPUT_DIR, type, itemId);
  await fs.mkdir(outputDir, { recursive: true });

  await updateProcessingStatus(data, 'processing');
  await job.updateProgress({ stage: 'metadata', progress: 5 });

  const metadata = await getMediaMetadata(data.inputPath);
  await job.updateProgress({ stage: 'processing', progress: 15 });

  const processed = await processVideo(data.inputPath, outputDir, {
    maxDurationSeconds: type === 'story' ? 15 : type === 'reel' ? 180 : 600,
    thumbnailAtPercent: 0.15,
    hlsSegmentSeconds: 4,
    crf: 23,
    preset: 'medium',
    keepOriginalAspect: true
  } as any);

  await job.updateProgress({ stage: 'uploading', progress: 75 });

  const prefix = getStoragePrefix(type, itemId);
  const uploaded = await uploadToS3(processed, prefix) as UploadedMediaResult;

  const payload: Record<string, any> = {
    videoUrl: uploaded.videoUrl || uploaded.mp4,
    hlsUrl: uploaded.hlsUrl || uploaded.hls,
    thumbnailUrl: uploaded.thumbnailUrl || uploaded.thumbnail,
    posterUrl: uploaded.posterUrl || uploaded.poster,
    previewUrl: uploaded.previewUrl || uploaded.preview,
    blurhash: uploaded.blurhash || processed.blurhash,
    metadata: {
      ...metadata,
      ...(processed.metadata || {}),
      ...(uploaded.metadata || {})
    },
    encodingStatus: 'completed',
    processingStatus: 'completed'
  };

  if (type === 'reel') {
    await prisma.reel.update({
      where: { id: itemId },
      data: {
        videoUrl: payload.videoUrl,
        hlsUrl: payload.hlsUrl,
        thumbnailUrl: payload.thumbnailUrl,
        blurhash: payload.blurhash,
        encodingStatus: 'completed',
        duration: payload.metadata?.duration || undefined,
        width: payload.metadata?.width || undefined,
        height: payload.metadata?.height || undefined
      }
    });
  } else if (type === 'story') {
    await prisma.story.update({
      where: { id: itemId },
      data: {
        mediaUrl: payload.videoUrl,
        thumbnailUrl: payload.thumbnailUrl,
        blurhash: payload.blurhash,
        processingStatus: 'completed',
        duration: Math.min(Math.ceil(payload.metadata?.duration || 15), 15)
      }
    });
  } else if (type === 'product') {
    await prisma.product.update({
      where: { id: itemId },
      data: {
        mediaUrls: { push: payload.videoUrl },
        primaryMediaUrl: payload.thumbnailUrl,
        attributes: {
          ...(data.metadata || {}),
          media: payload.metadata,
          video: {
            videoUrl: payload.videoUrl,
            hlsUrl: payload.hlsUrl,
            thumbnailUrl: payload.thumbnailUrl,
            posterUrl: payload.posterUrl,
            previewUrl: payload.previewUrl,
            blurhash: payload.blurhash
          }
        }
      }
    });
  } else {
    await updateProcessingStatus(data, 'completed', payload);
  }

  await job.updateProgress({ stage: 'completed', progress: 100 });

  await emitToUser(data.userId, `${type}:media_ready`, {
    itemId,
    type,
    ...payload
  });

  await emitToUser(data.userId, 'media:ready', {
    itemId,
    type,
    ...payload
  });

  await emitToStore(data.storeId, 'store:media_ready', {
    itemId,
    type,
    ...payload
  });

  try {
    await deleteLocalFiles([
      data.inputPath,
      processed.thumbnail,
      processed.poster,
      processed.preview,
      processed.mp4,
      processed.hls,
      processed.masterPlaylist,
      processed.outputDir
    ].filter(Boolean));
  } catch {}

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

  if (!itemId) throw new Error('Image job missing itemId');
  if (!data.userId) throw new Error('Image job missing userId');
  if (!data.inputPath) throw new Error('Image job missing inputPath');
  if (!(await safeExists(data.inputPath))) throw new Error(`Input file not found: ${data.inputPath}`);

  await updateProcessingStatus(data, 'processing');
  await job.updateProgress({ stage: 'reading', progress: 10 });

  const buffer = await fs.readFile(data.inputPath);
  const optimized = await optimizeImage(buffer, 'webp');
  const variants = await generateImageVariants(buffer, {
    format: 'webp',
    sizes: {
      thumb: 160,
      small: 360,
      medium: 720,
      large: 1200
    }
  } as any);

  await job.updateProgress({ stage: 'uploading', progress: 70 });

  const prefix = getStoragePrefix(type, itemId);
  const uploaded = await uploadToS3({
    optimized,
    variants
  }, prefix) as UploadedMediaResult;

  const imageUrl = uploaded.videoUrl || uploaded.thumbnailUrl || uploaded.posterUrl || uploaded.variants?.large || uploaded.variants?.medium || uploaded.variants?.small || uploaded.variants?.thumb;
  const payload = {
    imageUrl,
    thumbnailUrl: uploaded.variants?.thumb || uploaded.thumbnailUrl || imageUrl,
    variants: uploaded.variants || {},
    blurhash: optimized.blurhash,
    metadata: optimized.metadata || {}
  };

  if (type === 'avatar') {
    await prisma.user.update({
      where: { id: data.userId },
      data: {
        avatarUrl: payload.imageUrl
      }
    });
  } else if (type === 'banner') {
    await prisma.user.update({
      where: { id: data.userId },
      data: {
        bannerUrl: payload.imageUrl
      } as any
    });
  } else if (type === 'store') {
    await prisma.store.update({
      where: { id: itemId },
      data: data.metadata?.kind === 'logo'
        ? { logoUrl: payload.imageUrl }
        : { bannerUrl: payload.imageUrl }
    });
  } else if (type === 'product') {
    await prisma.product.update({
      where: { id: itemId },
      data: {
        mediaUrls: { push: payload.imageUrl },
        primaryMediaUrl: payload.imageUrl
      }
    });
  } else {
    await updateProcessingStatus(data, 'completed', payload);
  }

  await job.updateProgress({ stage: 'completed', progress: 100 });

  await emitToUser(data.userId, `${type}:media_ready`, {
    itemId,
    type,
    ...payload
  });

  await emitToUser(data.userId, 'media:ready', {
    itemId,
    type,
    ...payload
  });

  try {
    await deleteLocalFiles([data.inputPath]);
  } catch {}

  return {
    itemId,
    type,
    ...payload
  };
}

async function cleanupMediaJob(job: Job<MediaWorkerJobData>) {
  const data = job.data;
  const files = data.metadata?.files || [];
  if (!Array.isArray(files) || files.length === 0) return { cleaned: 0 };
  await deleteLocalFiles(files.filter(Boolean));
  return { cleaned: files.length };
}

export async function processMediaWorker(job: Job<MediaWorkerJobData, any, MediaJobName>) {
  const data = job.data;
  const itemId = getItemId(data);
  const type = getEntityType(data);

  try {
    if (!data.userId) throw new Error('Media worker requires userId');

    if (job.name === 'cleanup') {
      return await cleanupMediaJob(job);
    }

    if (data.mimeType?.startsWith('image/') || data.metadata?.mediaKind === 'image') {
      return await processImageJob(job);
    }

    const result = await processVideoJob(job);
    return result;
  } catch (error: any) {
    if (itemId) {
      try {
        await updateProcessingStatus(data, 'failed', {
          encodingStatus: 'failed',
          processingStatus: 'failed',
          processingError: error?.message || 'Media processing failed'
        });
      } catch {}
    }

    await emitToUser(data.userId, `${type}:media_failed`, {
      itemId,
      type,
      error: error?.message || 'Media processing failed'
    });

    await emitToUser(data.userId, 'media:failed', {
      itemId,
      type,
      error: error?.message || 'Media processing failed'
    });

    throw error;
  }
}
