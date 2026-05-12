import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from 'cloudinary';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

type ResourceType = 'image' | 'video' | 'raw' | 'auto';

type UploadOptions = UploadApiOptions & {
  resource_type?: ResourceType;
};

type VideoMetadata = {
  duration: number;
  width: number;
  height: number;
  resolution: string;
  format?: string;
  bitrate?: number;
  fps?: number;
  size?: number;
};

type DuetLayout = 'side_by_side' | 'pip';

type CdnUrls = {
  hls: string;
  dash: string;
  mp4_360: string;
  mp4_480: string;
  mp4_720: string;
  mp4_1080: string;
  preview: string;
  poster: string;
};

type CloudinaryUploadResult = UploadApiResponse & {
  secure_url: string;
  public_id: string;
  resource_type: string;
};

ffmpeg.setFfprobePath(ffprobeStatic.path);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const ensureCloudinaryReady = () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary credentials are missing');
  }
};

const safeFolder = (folder: string) => {
  return folder.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/^\/+|\/+$/g, '') || 'uploads';
};

const uniqueId = () => crypto.randomBytes(12).toString('hex');

const getExtFromMime = (mime?: string) => {
  if (!mime) return 'bin';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  return mime.split('/')[1]?.split(';')[0] || 'bin';
};

const writeTempFile = async (file: Express.Multer.File, prefix = 'media') => {
  const ext = path.extname(file.originalname || '')?.replace('.', '') || getExtFromMime(file.mimetype);
  const filePath = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${uniqueId()}.${ext}`);
  await fs.writeFile(filePath, file.buffer);
  return filePath;
};

const removeTempFile = async (filePath?: string) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {}
};

const uploadFilePathToCloudinary = async (
  filePath: string,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  ensureCloudinaryReady();
  return cloudinary.uploader.upload(filePath, {
    folder: `texa/${safeFolder(folder)}`,
    resource_type: options.resource_type || 'auto',
    overwrite: false,
    unique_filename: true,
    use_filename: false,
    invalidate: true,
    ...options
  }) as Promise<CloudinaryUploadResult>;
};

export const uploadToCloudinary = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  ensureCloudinaryReady();

  if (!file?.buffer?.length) {
    throw new Error('Invalid upload file');
  }

  const resourceType: ResourceType =
    options.resource_type ||
    (file.mimetype?.startsWith('video/')
      ? 'video'
      : file.mimetype?.startsWith('image/')
        ? 'image'
        : file.mimetype?.startsWith('audio/')
          ? 'video'
          : 'auto');

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `texa/${safeFolder(folder)}`,
        resource_type: resourceType,
        overwrite: false,
        unique_filename: true,
        use_filename: false,
        invalidate: true,
        quality: resourceType === 'image' || resourceType === 'video' ? 'auto:good' : undefined,
        fetch_format: resourceType === 'image' || resourceType === 'video' ? 'auto' : undefined,
        ...options
      },
      (error, result) => {
        if (error || !result) reject(error || new Error('Cloudinary upload failed'));
        else resolve(result as CloudinaryUploadResult);
      }
    );

    uploadStream.end(file.buffer);
  });
};

export const generateVideoThumbnails = async (videoUrl: string, timestamps: number[] = [0.1, 0.25, 0.5, 0.75, 0.9]): Promise<string[]> => {
  ensureCloudinaryReady();

  const cleanTimestamps = [...new Set(timestamps)]
    .map(t => Number(t))
    .filter(t => Number.isFinite(t))
    .map(t => Math.max(0.01, Math.min(0.99, t)))
    .slice(0, 8);

  return cleanTimestamps.map(ts =>
    cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      transformation: [
        {
          start_offset: `${Math.round(ts * 100)}p`,
          width: 720,
          height: 1280,
          crop: 'fill',
          gravity: 'auto',
          quality: 'auto:good',
          fetch_format: 'jpg'
        }
      ]
    })
  );
};

export const transcodeVideo = async (videoUrl: string, reelId: string): Promise<CdnUrls> => {
  ensureCloudinaryReady();

  const baseTransformation = [
    { crop: 'limit', quality: 'auto:good', fetch_format: 'auto', video_codec: 'auto', audio_codec: 'aac' }
  ];

  return {
    hls: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'm3u8',
      streaming_profile: 'hd',
      transformation: [{ quality: 'auto:good', video_codec: 'auto' }]
    }),
    dash: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mpd',
      streaming_profile: 'hd',
      transformation: [{ quality: 'auto:good', video_codec: 'auto' }]
    }),
    mp4_360: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 360, height: 640, ...baseTransformation[0] }]
    }),
    mp4_480: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 480, height: 854, ...baseTransformation[0] }]
    }),
    mp4_720: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 720, height: 1280, ...baseTransformation[0] }]
    }),
    mp4_1080: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 1080, height: 1920, ...baseTransformation[0] }]
    }),
    preview: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [
        { start_offset: '0', duration: '3', width: 360, height: 640, crop: 'fill', gravity: 'auto', quality: 'auto:eco', video_codec: 'auto' }
      ]
    }),
    poster: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'jpg',
      transformation: [
        { start_offset: '50p', width: 720, height: 1280, crop: 'fill', gravity: 'auto', quality: 'auto:good' }
      ]
    })
  };
};

export const getVideoMetadata = async (videoUrl: string): Promise<VideoMetadata> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoUrl, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      const format = metadata.format;

      const width = Number(videoStream?.width || 0);
      const height = Number(videoStream?.height || 0);
      const duration = Number(format.duration || videoStream?.duration || 0);
      const bitrate = Number(format.bit_rate || videoStream?.bit_rate || 0);
      const fpsRaw = videoStream?.avg_frame_rate || videoStream?.r_frame_rate || '0/1';
      const [fpsN, fpsD] = fpsRaw.split('/').map(Number);
      const fps = fpsD ? fpsN / fpsD : fpsN || 0;

      const maxSide = Math.max(width, height);
      const resolution =
        maxSide >= 2160 ? '4K' :
        maxSide >= 1440 ? '1440p' :
        maxSide >= 1080 ? '1080p' :
        maxSide >= 720 ? '720p' :
        maxSide >= 480 ? '480p' :
        maxSide >= 360 ? '360p' :
        `${width}x${height}`;

      resolve({
        duration: Number(duration.toFixed(2)),
        width,
        height,
        resolution,
        format: format.format_name,
        bitrate,
        fps: Number(fps.toFixed(2)),
        size: Number(format.size || 0)
      });
    });
  });
};

const runFfmpeg = (command: ffmpeg.FfmpegCommand) => {
  return new Promise<void>((resolve, reject) => {
    command.on('end', () => resolve()).on('error', reject).run();
  });
};

export const composeDuetVideo = async (
  originalUrl: string,
  newUserUrl: string,
  layout: DuetLayout = 'side_by_side'
): Promise<string> => {
  ensureCloudinaryReady();

  const outputPath = path.join(os.tmpdir(), `duet_${Date.now()}_${uniqueId()}.mp4`);

  try {
    const command = ffmpeg();

    command.input(originalUrl);
    command.input(newUserUrl);

    if (layout === 'pip') {
      command.complexFilter([
        '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]',
        '[1:v]scale=360:640:force_original_aspect_ratio=increase,crop=360:640[pip]',
        '[base][pip]overlay=W-w-36:H-h-120[v]',
        '[0:a]volume=0.45[a0]',
        '[1:a]volume=1[a1]',
        '[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=2[a]'
      ]);
    } else {
      command.complexFilter([
        '[0:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[left]',
        '[1:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[right]',
        '[left][right]hstack=inputs=2,scale=1080:1920[v]',
        '[0:a]volume=0.55[a0]',
        '[1:a]volume=1[a1]',
        '[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=2[a]'
      ]);
    }

    command
      .outputOptions([
        '-map [v]',
        '-map [a]',
        '-c:v libx264',
        '-preset veryfast',
        '-profile:v high',
        '-level 4.1',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-shortest'
      ])
      .output(outputPath);

    await runFfmpeg(command);

    const uploaded = await uploadFilePathToCloudinary(outputPath, 'reels/duets', {
      resource_type: 'video',
      transformation: [
        { width: 1080, height: 1920, crop: 'limit' },
        { quality: 'auto:good', fetch_format: 'auto' }
      ]
    });

    return uploaded.secure_url;
  } finally {
    await removeTempFile(outputPath);
  }
};

export const extractClip = async (videoUrl: string, start: number, end: number): Promise<string> => {
  ensureCloudinaryReady();

  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd = Math.max(safeStart + 0.1, Number(end) || safeStart + 5);
  const duration = Math.min(5, safeEnd - safeStart);

  return cloudinary.url(videoUrl, {
    resource_type: 'video',
    secure: true,
    format: 'mp4',
    transformation: [
      {
        start_offset: safeStart,
        duration,
        width: 1080,
        height: 1920,
        crop: 'limit',
        quality: 'auto:good',
        fetch_format: 'auto',
        video_codec: 'auto',
        audio_codec: 'aac'
      }
    ]
  });
};

export const uploadOptimizedImage = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  return uploadToCloudinary(file, folder, {
    resource_type: 'image',
    transformation: [
      { width: 1600, height: 1600, crop: 'limit' },
      { quality: 'auto:good', fetch_format: 'auto' }
    ],
    ...options
  });
};

export const uploadOptimizedVideo = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  return uploadToCloudinary(file, folder, {
    resource_type: 'video',
    transformation: [
      { width: 1080, height: 1920, crop: 'limit' },
      { quality: 'auto:good', fetch_format: 'auto', video_codec: 'auto', audio_codec: 'aac' }
    ],
    eager: [
      { width: 360, height: 640, crop: 'limit', format: 'mp4', quality: 'auto:eco' },
      { width: 720, height: 1280, crop: 'limit', format: 'mp4', quality: 'auto:good' },
      { width: 1080, height: 1920, crop: 'limit', format: 'mp4', quality: 'auto:good' }
    ],
    eager_async: true,
    ...options
  });
};

export const deleteFromCloudinary = async (publicId: string, resourceType: ResourceType = 'image') => {
  ensureCloudinaryReady();

  if (!publicId) {
    throw new Error('Public id is required');
  }

  return cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true
  });
};

export const createSignedUploadParams = (folder: string, resourceType: ResourceType = 'auto') => {
  ensureCloudinaryReady();

  const timestamp = Math.round(Date.now() / 1000);
  const params = {
    timestamp,
    folder: `texa/${safeFolder(folder)}`,
    resource_type: resourceType,
    overwrite: false,
    unique_filename: true
  };

  const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET!);

  return {
    ...params,
    signature,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY
  };
};

export const buildResponsiveVideoSources = (videoUrl: string) => {
  return {
    low: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 360, height: 640, crop: 'limit', quality: 'auto:eco', video_codec: 'auto' }]
    }),
    medium: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 720, height: 1280, crop: 'limit', quality: 'auto:good', video_codec: 'auto' }]
    }),
    high: cloudinary.url(videoUrl, {
      resource_type: 'video',
      secure: true,
      format: 'mp4',
      transformation: [{ width: 1080, height: 1920, crop: 'limit', quality: 'auto:best', video_codec: 'auto' }]
    })
  };
};

export const buildImageVariants = (imageUrl: string) => {
  return {
    thumb: cloudinary.url(imageUrl, {
      resource_type: 'image',
      secure: true,
      transformation: [{ width: 160, height: 160, crop: 'fill', gravity: 'auto', quality: 'auto:good', fetch_format: 'auto' }]
    }),
    small: cloudinary.url(imageUrl, {
      resource_type: 'image',
      secure: true,
      transformation: [{ width: 480, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }]
    }),
    medium: cloudinary.url(imageUrl, {
      resource_type: 'image',
      secure: true,
      transformation: [{ width: 960, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }]
    }),
    large: cloudinary.url(imageUrl, {
      resource_type: 'image',
      secure: true,
      transformation: [{ width: 1600, crop: 'limit', quality: 'auto:best', fetch_format: 'auto' }]
    })
  };
};
