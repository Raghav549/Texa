import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from "cloudinary";
import ffmpeg from "fluent-ffmpeg";
import ffprobeStatic from "ffprobe-static";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

type ResourceType = "image" | "video" | "raw" | "auto";

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
  hasAudio?: boolean;
  hasVideo?: boolean;
  codec?: string;
  audioCodec?: string;
  aspectRatio?: string;
};

type DuetLayout = "side_by_side" | "pip";

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

type ImageVariants = {
  thumb: string;
  small: string;
  medium: string;
  large: string;
  square: string;
  blur: string;
  original: string;
};

type ResponsiveVideoSources = {
  low: string;
  medium: string;
  high: string;
  ultra: string;
  hls: string;
  poster: string;
  preview: string;
};

type CloudinaryUploadResult = UploadApiResponse & {
  secure_url: string;
  public_id: string;
  resource_type: string;
};

type MediaValidationOptions = {
  maxSize?: number;
  allowedMimeTypes?: string[];
  allowedPrefixes?: string[];
};

const CLOUDINARY_ROOT_FOLDER = "texa";
const DEFAULT_IMAGE_MAX_SIZE = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_SIZE = 500 * 1024 * 1024;
const DEFAULT_RAW_MAX_SIZE = 50 * 1024 * 1024;
const MAX_THUMBNAILS = 8;
const DEFAULT_VIDEO_WIDTH = 1080;
const DEFAULT_VIDEO_HEIGHT = 1920;

if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const ensureCloudinaryReady = () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary credentials are missing");
  }
};

const uniqueId = () => crypto.randomBytes(12).toString("hex");

const safeFolder = (folder: string) => {
  return String(folder || "")
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "") || "uploads";
};

const safePublicId = (publicId: string) => {
  return String(publicId || "")
    .replace(/\\/g, "/")
    .replace(/^https?:\/\/res\.cloudinary\.com\/[^/]+\/(?:image|video|raw)\/upload\//i, "")
    .replace(/^v\d+\//, "")
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[^a-zA-Z0-9/_:.-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
};

const rootFolder = (folder: string) => {
  return `${CLOUDINARY_ROOT_FOLDER}/${safeFolder(folder)}`;
};

const getExtFromMime = (mime?: string) => {
  const value = String(mime || "").toLowerCase();

  if (!value) return "bin";
  if (value.includes("mp4")) return "mp4";
  if (value.includes("quicktime")) return "mov";
  if (value.includes("webm")) return "webm";
  if (value.includes("x-matroska")) return "mkv";
  if (value.includes("mpeg")) return "mp3";
  if (value.includes("wav")) return "wav";
  if (value.includes("aac")) return "aac";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("png")) return "png";
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  if (value.includes("svg")) return "svg";
  if (value.includes("pdf")) return "pdf";

  return value.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/g, "") || "bin";
};

const getResourceTypeFromMime = (mime?: string): ResourceType => {
  const value = String(mime || "").toLowerCase();

  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "video";

  return "auto";
};

const ensureFileBuffer = (file: Express.Multer.File) => {
  if (!file?.buffer?.length) throw new Error("Invalid upload file");
};

const validateMediaFile = (file: Express.Multer.File, options: MediaValidationOptions = {}) => {
  ensureFileBuffer(file);

  const mime = String(file.mimetype || "").toLowerCase();
  const size = Number(file.size || file.buffer.length || 0);
  const resourceType = getResourceTypeFromMime(mime);

  const maxSize =
    options.maxSize ||
    (resourceType === "image" ? DEFAULT_IMAGE_MAX_SIZE : resourceType === "video" ? DEFAULT_VIDEO_MAX_SIZE : DEFAULT_RAW_MAX_SIZE);

  if (size > maxSize) throw new Error("File size is too large");

  if (options.allowedMimeTypes?.length && !options.allowedMimeTypes.map(item => item.toLowerCase()).includes(mime)) {
    throw new Error("File type is not allowed");
  }

  if (options.allowedPrefixes?.length && !options.allowedPrefixes.some(prefix => mime.startsWith(prefix.toLowerCase()))) {
    throw new Error("File type is not allowed");
  }

  return {
    mime,
    size,
    resourceType
  };
};

const writeTempFile = async (file: Express.Multer.File, prefix = "media") => {
  ensureFileBuffer(file);

  const ext = path.extname(file.originalname || "")?.replace(".", "") || getExtFromMime(file.mimetype);
  const safePrefix = String(prefix || "media").replace(/[^a-zA-Z0-9_-]/g, "") || "media";
  const filePath = path.join(os.tmpdir(), `${safePrefix}_${Date.now()}_${uniqueId()}.${ext}`);

  await fs.writeFile(filePath, file.buffer);

  return filePath;
};

const removeTempFile = async (filePath?: string) => {
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch {}
};

const cloudinaryUrl = (publicIdOrUrl: string, options: Record<string, any>) => {
  ensureCloudinaryReady();

  const source = String(publicIdOrUrl || "").trim();

  if (!source) throw new Error("Media source is required");

  return cloudinary.url(source, {
    secure: true,
    sign_url: false,
    ...options
  });
};

const uploadFilePathToCloudinary = async (
  filePath: string,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  ensureCloudinaryReady();

  if (!filePath) throw new Error("File path is required");

  const result = await cloudinary.uploader.upload(filePath, {
    folder: rootFolder(folder),
    resource_type: options.resource_type || "auto",
    overwrite: false,
    unique_filename: true,
    use_filename: false,
    invalidate: true,
    ...options
  });

  return result as CloudinaryUploadResult;
};

const runFfmpeg = (command: ffmpeg.FfmpegCommand) => {
  return new Promise<void>((resolve, reject) => {
    command.on("end", () => resolve()).on("error", reject).run();
  });
};

const parseFps = (value?: string) => {
  if (!value) return 0;

  const [n, d] = value.split("/").map(Number);

  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(d) || d === 0) return n;

  return n / d;
};

const gcd = (a: number, b: number): number => {
  return b === 0 ? a : gcd(b, a % b);
};

const aspectRatio = (width: number, height: number) => {
  if (!width || !height) return "0:0";

  const divisor = gcd(width, height);

  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
};

const resolutionLabel = (width: number, height: number) => {
  const maxSide = Math.max(width, height);

  if (maxSide >= 4320) return "8K";
  if (maxSide >= 2160) return "4K";
  if (maxSide >= 1440) return "1440p";
  if (maxSide >= 1080) return "1080p";
  if (maxSide >= 720) return "720p";
  if (maxSide >= 480) return "480p";
  if (maxSide >= 360) return "360p";

  return `${width}x${height}`;
};

const normalizeTimestamps = (timestamps: number[]) => {
  return [...new Set((timestamps || []).map(Number))]
    .filter(value => Number.isFinite(value))
    .map(value => Math.max(0.01, Math.min(0.99, value)))
    .slice(0, MAX_THUMBNAILS);
};

export const uploadToCloudinary = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  ensureCloudinaryReady();

  const validated = validateMediaFile(file);
  const resourceType: ResourceType = options.resource_type || validated.resourceType;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: rootFolder(folder),
        resource_type: resourceType,
        overwrite: false,
        unique_filename: true,
        use_filename: false,
        invalidate: true,
        quality: resourceType === "image" || resourceType === "video" ? "auto:good" : undefined,
        fetch_format: resourceType === "image" || resourceType === "video" ? "auto" : undefined,
        ...options
      },
      (error, result) => {
        if (error || !result) reject(error || new Error("Cloudinary upload failed"));
        else resolve(result as CloudinaryUploadResult);
      }
    );

    uploadStream.end(file.buffer);
  });
};

export const uploadBufferToCloudinary = async (
  buffer: Buffer,
  folder: string,
  mimetype = "application/octet-stream",
  originalname = `upload_${uniqueId()}.${getExtFromMime(mimetype)}`,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  const file = {
    buffer,
    mimetype,
    originalname,
    size: buffer.length
  } as Express.Multer.File;

  return uploadToCloudinary(file, folder, options);
};

export const uploadLocalFileToCloudinary = async (
  filePath: string,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  return uploadFilePathToCloudinary(filePath, folder, options);
};

export const uploadOptimizedImage = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  validateMediaFile(file, {
    maxSize: options.resource_type === "raw" ? DEFAULT_RAW_MAX_SIZE : DEFAULT_IMAGE_MAX_SIZE,
    allowedPrefixes: ["image/"]
  });

  return uploadToCloudinary(file, folder, {
    resource_type: "image",
    transformation: [
      { width: 1600, height: 1600, crop: "limit" },
      { quality: "auto:good", fetch_format: "auto" }
    ],
    ...options
  });
};

export const uploadAvatarImage = async (
  file: Express.Multer.File,
  folder = "avatars",
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  validateMediaFile(file, {
    maxSize: 8 * 1024 * 1024,
    allowedPrefixes: ["image/"]
  });

  return uploadToCloudinary(file, folder, {
    resource_type: "image",
    transformation: [
      { width: 512, height: 512, crop: "fill", gravity: "face:auto" },
      { quality: "auto:good", fetch_format: "auto" }
    ],
    ...options
  });
};

export const uploadCoverImage = async (
  file: Express.Multer.File,
  folder = "covers",
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  validateMediaFile(file, {
    maxSize: DEFAULT_IMAGE_MAX_SIZE,
    allowedPrefixes: ["image/"]
  });

  return uploadToCloudinary(file, folder, {
    resource_type: "image",
    transformation: [
      { width: 1920, height: 720, crop: "fill", gravity: "auto" },
      { quality: "auto:good", fetch_format: "auto" }
    ],
    ...options
  });
};

export const uploadOptimizedVideo = async (
  file: Express.Multer.File,
  folder: string,
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  validateMediaFile(file, {
    maxSize: DEFAULT_VIDEO_MAX_SIZE,
    allowedPrefixes: ["video/", "audio/"]
  });

  return uploadToCloudinary(file, folder, {
    resource_type: "video",
    transformation: [
      { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT, crop: "limit" },
      { quality: "auto:good", fetch_format: "auto", video_codec: "auto", audio_codec: "aac" }
    ],
    eager: [
      { width: 360, height: 640, crop: "limit", format: "mp4", quality: "auto:eco", video_codec: "auto", audio_codec: "aac" },
      { width: 720, height: 1280, crop: "limit", format: "mp4", quality: "auto:good", video_codec: "auto", audio_codec: "aac" },
      { width: 1080, height: 1920, crop: "limit", format: "mp4", quality: "auto:good", video_codec: "auto", audio_codec: "aac" }
    ],
    eager_async: true,
    ...options
  });
};

export const uploadRawFile = async (
  file: Express.Multer.File,
  folder = "files",
  options: UploadOptions = {}
): Promise<CloudinaryUploadResult> => {
  validateMediaFile(file, {
    maxSize: DEFAULT_RAW_MAX_SIZE
  });

  return uploadToCloudinary(file, folder, {
    resource_type: "raw",
    ...options
  });
};

export const generateVideoThumbnails = async (
  videoUrl: string,
  timestamps: number[] = [0.1, 0.25, 0.5, 0.75, 0.9]
): Promise<string[]> => {
  ensureCloudinaryReady();

  const cleanTimestamps = normalizeTimestamps(timestamps);

  return cleanTimestamps.map(ts =>
    cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "jpg",
      transformation: [
        {
          start_offset: `${Math.round(ts * 100)}p`,
          width: 720,
          height: 1280,
          crop: "fill",
          gravity: "auto",
          quality: "auto:good"
        }
      ]
    })
  );
};

export const transcodeVideo = async (videoUrl: string, reelId?: string): Promise<CdnUrls> => {
  ensureCloudinaryReady();

  const baseTransformation = {
    crop: "limit",
    quality: "auto:good",
    fetch_format: "auto",
    video_codec: "auto",
    audio_codec: "aac"
  };

  const named = reelId ? safePublicId(reelId) : undefined;

  return {
    hls: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "m3u8",
      streaming_profile: "hd",
      transformation: [{ quality: "auto:good", video_codec: "auto", audio_codec: "aac" }],
      public_id: named
    }),
    dash: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mpd",
      streaming_profile: "hd",
      transformation: [{ quality: "auto:good", video_codec: "auto", audio_codec: "aac" }],
      public_id: named
    }),
    mp4_360: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 360, height: 640, ...baseTransformation }]
    }),
    mp4_480: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 480, height: 854, ...baseTransformation }]
    }),
    mp4_720: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 720, height: 1280, ...baseTransformation }]
    }),
    mp4_1080: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 1080, height: 1920, ...baseTransformation }]
    }),
    preview: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [
        {
          start_offset: "0",
          duration: "3",
          width: 360,
          height: 640,
          crop: "fill",
          gravity: "auto",
          quality: "auto:eco",
          video_codec: "auto",
          audio_codec: "aac"
        }
      ]
    }),
    poster: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "jpg",
      transformation: [
        {
          start_offset: "50p",
          width: 720,
          height: 1280,
          crop: "fill",
          gravity: "auto",
          quality: "auto:good"
        }
      ]
    })
  };
};

export const getVideoMetadata = async (videoUrl: string): Promise<VideoMetadata> => {
  if (!videoUrl) throw new Error("Video url is required");

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoUrl, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const videoStream = metadata.streams.find(stream => stream.codec_type === "video");
      const audioStream = metadata.streams.find(stream => stream.codec_type === "audio");
      const format = metadata.format;

      const width = Number(videoStream?.width || 0);
      const height = Number(videoStream?.height || 0);
      const duration = Number(format.duration || videoStream?.duration || audioStream?.duration || 0);
      const bitrate = Number(format.bit_rate || videoStream?.bit_rate || audioStream?.bit_rate || 0);
      const fps = parseFps(videoStream?.avg_frame_rate || videoStream?.r_frame_rate || "0/1");

      resolve({
        duration: Number((Number.isFinite(duration) ? duration : 0).toFixed(2)),
        width,
        height,
        resolution: resolutionLabel(width, height),
        format: format.format_name,
        bitrate: Number.isFinite(bitrate) ? bitrate : 0,
        fps: Number((Number.isFinite(fps) ? fps : 0).toFixed(2)),
        size: Number(format.size || 0),
        hasAudio: !!audioStream,
        hasVideo: !!videoStream,
        codec: videoStream?.codec_name || undefined,
        audioCodec: audioStream?.codec_name || undefined,
        aspectRatio: aspectRatio(width, height)
      });
    });
  });
};

export const composeDuetVideo = async (
  originalUrl: string,
  newUserUrl: string,
  layout: DuetLayout = "side_by_side"
): Promise<string> => {
  ensureCloudinaryReady();

  if (!originalUrl || !newUserUrl) throw new Error("Both videos are required");

  const outputPath = path.join(os.tmpdir(), `duet_${Date.now()}_${uniqueId()}.mp4`);

  try {
    const command = ffmpeg();

    command.input(originalUrl);
    command.input(newUserUrl);

    if (layout === "pip") {
      command.complexFilter([
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]",
        "[1:v]scale=360:640:force_original_aspect_ratio=increase,crop=360:640[pip]",
        "[base][pip]overlay=W-w-36:H-h-120[v]",
        "[0:a]volume=0.45[a0]",
        "[1:a]volume=1[a1]",
        "[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=2[a]"
      ]);
    } else {
      command.complexFilter([
        "[0:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[left]",
        "[1:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[right]",
        "[left][right]hstack=inputs=2,scale=1080:1920[v]",
        "[0:a]volume=0.55[a0]",
        "[1:a]volume=1[a1]",
        "[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=2[a]"
      ]);
    }

    command
      .outputOptions([
        "-map [v]",
        "-map [a]",
        "-c:v libx264",
        "-preset veryfast",
        "-profile:v high",
        "-level 4.1",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 128k",
        "-movflags +faststart",
        "-shortest"
      ])
      .output(outputPath);

    try {
      await runFfmpeg(command);
    } catch {
      const fallback = ffmpeg();

      fallback.input(originalUrl);
      fallback.input(newUserUrl);

      if (layout === "pip") {
        fallback.complexFilter([
          "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[base]",
          "[1:v]scale=360:640:force_original_aspect_ratio=increase,crop=360:640[pip]",
          "[base][pip]overlay=W-w-36:H-h-120[v]"
        ]);
      } else {
        fallback.complexFilter([
          "[0:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[left]",
          "[1:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960[right]",
          "[left][right]hstack=inputs=2,scale=1080:1920[v]"
        ]);
      }

      fallback
        .outputOptions([
          "-map [v]",
          "-c:v libx264",
          "-preset veryfast",
          "-profile:v high",
          "-level 4.1",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
          "-shortest"
        ])
        .output(outputPath);

      await runFfmpeg(fallback);
    }

    const uploaded = await uploadFilePathToCloudinary(outputPath, "reels/duets", {
      resource_type: "video",
      transformation: [
        { width: 1080, height: 1920, crop: "limit" },
        { quality: "auto:good", fetch_format: "auto", video_codec: "auto", audio_codec: "aac" }
      ]
    });

    return uploaded.secure_url;
  } finally {
    await removeTempFile(outputPath);
  }
};

export const extractClip = async (videoUrl: string, start: number, end: number): Promise<string> => {
  ensureCloudinaryReady();

  if (!videoUrl) throw new Error("Video url is required");

  const safeStart = Math.max(0, Number(start) || 0);
  const safeEnd = Math.max(safeStart + 0.1, Number(end) || safeStart + 5);
  const duration = Math.max(0.1, Math.min(60, safeEnd - safeStart));

  return cloudinaryUrl(videoUrl, {
    resource_type: "video",
    format: "mp4",
    transformation: [
      {
        start_offset: safeStart,
        duration,
        width: 1080,
        height: 1920,
        crop: "limit",
        quality: "auto:good",
        fetch_format: "auto",
        video_codec: "auto",
        audio_codec: "aac"
      }
    ]
  });
};

export const deleteFromCloudinary = async (publicId: string, resourceType: ResourceType = "image") => {
  ensureCloudinaryReady();

  const safeId = safePublicId(publicId);

  if (!safeId) throw new Error("Public id is required");

  return cloudinary.uploader.destroy(safeId, {
    resource_type: resourceType,
    invalidate: true
  });
};

export const deleteManyFromCloudinary = async (items: Array<{ publicId: string; resourceType?: ResourceType }>) => {
  ensureCloudinaryReady();

  const results = await Promise.allSettled(
    items
      .filter(item => item?.publicId)
      .map(item => deleteFromCloudinary(item.publicId, item.resourceType || "image"))
  );

  return {
    success: results.filter(item => item.status === "fulfilled").length,
    failed: results.filter(item => item.status === "rejected").length,
    results
  };
};

export const renameCloudinaryAsset = async (
  fromPublicId: string,
  toPublicId: string,
  resourceType: ResourceType = "image"
) => {
  ensureCloudinaryReady();

  const from = safePublicId(fromPublicId);
  const to = safePublicId(toPublicId);

  if (!from || !to) throw new Error("Valid public ids are required");

  return cloudinary.uploader.rename(from, to, {
    resource_type: resourceType,
    overwrite: false,
    invalidate: true
  });
};

export const createSignedUploadParams = (folder: string, resourceType: ResourceType = "auto") => {
  ensureCloudinaryReady();

  const timestamp = Math.round(Date.now() / 1000);
  const params = {
    timestamp,
    folder: rootFolder(folder),
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

export const createSignedDeliveryUrl = (
  publicId: string,
  resourceType: ResourceType = "image",
  expiresInSeconds = 300,
  options: Record<string, any> = {}
) => {
  ensureCloudinaryReady();

  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(86400, Number(expiresInSeconds) || 300));

  return cloudinary.url(safePublicId(publicId), {
    resource_type: resourceType,
    secure: true,
    sign_url: true,
    expires_at: expiresAt,
    ...options
  });
};

export const buildResponsiveVideoSources = (videoUrl: string): ResponsiveVideoSources => {
  return {
    low: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 360, height: 640, crop: "limit", quality: "auto:eco", video_codec: "auto", audio_codec: "aac" }]
    }),
    medium: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 720, height: 1280, crop: "limit", quality: "auto:good", video_codec: "auto", audio_codec: "aac" }]
    }),
    high: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 1080, height: 1920, crop: "limit", quality: "auto:best", video_codec: "auto", audio_codec: "aac" }]
    }),
    ultra: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 1440, height: 2560, crop: "limit", quality: "auto:best", video_codec: "auto", audio_codec: "aac" }]
    }),
    hls: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "m3u8",
      streaming_profile: "hd",
      transformation: [{ quality: "auto:good", video_codec: "auto", audio_codec: "aac" }]
    }),
    poster: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "jpg",
      transformation: [{ start_offset: "50p", width: 720, height: 1280, crop: "fill", gravity: "auto", quality: "auto:good" }]
    }),
    preview: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ start_offset: "0", duration: "3", width: 360, height: 640, crop: "fill", gravity: "auto", quality: "auto:eco", video_codec: "auto" }]
    })
  };
};

export const buildImageVariants = (imageUrl: string): ImageVariants => {
  return {
    thumb: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 160, height: 160, crop: "fill", gravity: "auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    small: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 480, crop: "limit", quality: "auto:good", fetch_format: "auto" }]
    }),
    medium: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 960, crop: "limit", quality: "auto:good", fetch_format: "auto" }]
    }),
    large: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 1600, crop: "limit", quality: "auto:best", fetch_format: "auto" }]
    }),
    square: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 800, height: 800, crop: "fill", gravity: "auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    blur: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 40, quality: "auto:low", effect: "blur:1000", fetch_format: "auto" }]
    }),
    original: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ quality: "auto:best", fetch_format: "auto" }]
    })
  };
};

export const buildAvatarVariants = (imageUrl: string) => {
  return {
    tiny: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 48, height: 48, crop: "fill", gravity: "face:auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    small: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 96, height: 96, crop: "fill", gravity: "face:auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    medium: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 256, height: 256, crop: "fill", gravity: "face:auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    large: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 512, height: 512, crop: "fill", gravity: "face:auto", quality: "auto:best", fetch_format: "auto" }]
    })
  };
};

export const buildProductImageVariants = (imageUrl: string) => {
  return {
    card: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 700, height: 900, crop: "fill", gravity: "auto", quality: "auto:good", fetch_format: "auto" }]
    }),
    detail: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 1400, crop: "limit", quality: "auto:best", fetch_format: "auto" }]
    }),
    zoom: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 2400, crop: "limit", quality: "auto:best", fetch_format: "auto" }]
    }),
    thumb: cloudinaryUrl(imageUrl, {
      resource_type: "image",
      transformation: [{ width: 180, height: 180, crop: "fill", gravity: "auto", quality: "auto:good", fetch_format: "auto" }]
    })
  };
};

export const buildStoryVideoSources = (videoUrl: string) => {
  return {
    stream: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "mp4",
      transformation: [{ width: 720, height: 1280, crop: "fill", gravity: "auto", quality: "auto:good", video_codec: "auto", audio_codec: "aac" }]
    }),
    poster: cloudinaryUrl(videoUrl, {
      resource_type: "video",
      format: "jpg",
      transformation: [{ start_offset: "20p", width: 720, height: 1280, crop: "fill", gravity: "auto", quality: "auto:good" }]
    })
  };
};

export const buildBlurPlaceholder = (imageUrl: string) => {
  return cloudinaryUrl(imageUrl, {
    resource_type: "image",
    transformation: [{ width: 24, quality: "auto:low", effect: "blur:1200", fetch_format: "auto" }]
  });
};

export const extractCloudinaryPublicId = (urlOrPublicId: string) => {
  return safePublicId(urlOrPublicId);
};

export const getCloudinaryResourceType = (mimetype?: string): ResourceType => {
  return getResourceTypeFromMime(mimetype);
};

export const createMediaFingerprint = (buffer: Buffer) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Invalid buffer");
  return crypto.createHash("sha256").update(buffer).digest("hex");
};

export const writeUploadToTempFile = writeTempFile;

export const removeUploadTempFile = removeTempFile;

export const cloudinaryClient = cloudinary;
