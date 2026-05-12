import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { encode } from 'blurhash';

if (!ffmpegPath) {
  throw new Error('ffmpeg-static path not found');
}

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

export type VideoRendition = {
  label: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  path: string;
  urlPath: string;
};

export type ProcessVideoResult = {
  id: string;
  filename: string;
  duration: number;
  width: number;
  height: number;
  aspectRatio: number;
  size: number;
  thumbnail: string;
  poster: string;
  preview: string;
  hls: string;
  masterPlaylist: string;
  mp4: string;
  renditions: VideoRendition[];
  blurhash: string;
  metadata: {
    codec?: string;
    fps?: number;
    bitrate?: number;
    audioCodec?: string;
    hasAudio: boolean;
    format?: string;
  };
};

export type ImageOptimizationResult = {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  size: number;
  blurhash: string;
};

type ProcessVideoOptions = {
  maxDurationSeconds?: number;
  thumbnailAtPercent?: number;
  hlsSegmentSeconds?: number;
  crf?: number;
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  keepOriginalAspect?: boolean;
};

const DEFAULT_OPTIONS: Required<ProcessVideoOptions> = {
  maxDurationSeconds: 180,
  thumbnailAtPercent: 0.15,
  hlsSegmentSeconds: 4,
  crf: 23,
  preset: 'veryfast',
  keepOriginalAspect: true
};

const VIDEO_RENDITIONS = [
  { label: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k' },
  { label: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k' },
  { label: '720p', width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k' },
  { label: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' }
];

function safeName(filePath: string) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function createId(inputPath: string) {
  return crypto.createHash('sha1').update(`${inputPath}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16);
}

function ensureDir(dir: string) {
  return fs.promises.mkdir(dir, { recursive: true });
}

function fileExists(filePath: string) {
  return fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);
}

function ffprobe(inputPath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function runFfmpeg(command: ffmpeg.FfmpegCommand) {
  return new Promise<void>((resolve, reject) => {
    command.on('end', () => resolve()).on('error', reject).run();
  });
}

function getVideoStream(meta: ffmpeg.FfprobeData) {
  return meta.streams.find(stream => stream.codec_type === 'video');
}

function getAudioStream(meta: ffmpeg.FfprobeData) {
  return meta.streams.find(stream => stream.codec_type === 'audio');
}

function getFps(rate?: string) {
  if (!rate || !rate.includes('/')) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return Number((num / den).toFixed(2));
}

function getDuration(meta: ffmpeg.FfprobeData) {
  const duration = Number(meta.format.duration || 0);
  return Number.isFinite(duration) ? duration : 0;
}

function scaleFilter(width: number, height: number) {
  return `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
}

async function createThumbnail(inputPath: string, outputPath: string, duration: number, percent: number) {
  const timestamp = Math.max(0.1, duration * percent);
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        '-y',
        '-frames:v 1',
        '-q:v 2',
        `-ss ${timestamp}`
      ])
      .output(outputPath)
  );
  return outputPath;
}

async function createPoster(inputPath: string, outputPath: string, duration: number) {
  const timestamp = Math.max(0.1, duration * 0.05);
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        '-y',
        '-frames:v 1',
        '-q:v 3',
        `-ss ${timestamp}`
      ])
      .output(outputPath)
  );
  await sharp(outputPath)
    .resize(720, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toFile(`${outputPath}.tmp`);
  await fs.promises.rename(`${outputPath}.tmp`, outputPath);
  return outputPath;
}

async function createPreview(inputPath: string, outputPath: string, duration: number) {
  const start = Math.max(0, duration * 0.2);
  const previewDuration = Math.min(4, Math.max(1.5, duration * 0.2));
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        '-y',
        `-ss ${start}`,
        `-t ${previewDuration}`,
        '-vf fps=12,scale=360:-1:flags=lanczos',
        '-loop 0'
      ])
      .output(outputPath)
  );
  return outputPath;
}

async function createCompressedMp4(inputPath: string, outputPath: string, maxWidth: number, maxHeight: number, crf: number, preset: string, hasAudio: boolean) {
  const command = ffmpeg(inputPath)
    .videoCodec('libx264')
    .outputOptions([
      '-y',
      '-movflags +faststart',
      `-preset ${preset}`,
      `-crf ${crf}`,
      `-vf ${scaleFilter(maxWidth, maxHeight)}`,
      '-profile:v high',
      '-level 4.1'
    ]);

  if (hasAudio) {
    command.audioCodec('aac').audioBitrate('128k').outputOptions(['-ac 2']);
  } else {
    command.noAudio();
  }

  await new Promise<void>((resolve, reject) => {
    command.save(outputPath).on('end', resolve).on('error', reject);
  });

  return outputPath;
}

async function createHlsRendition(inputPath: string, rendition: Omit<VideoRendition, 'path' | 'urlPath'>, outputDir: string, segmentSeconds: number, crf: number, preset: string, hasAudio: boolean): Promise<VideoRendition> {
  const renditionDir = path.join(outputDir, rendition.label);
  await ensureDir(renditionDir);

  const playlistPath = path.join(renditionDir, 'index.m3u8');
  const segmentPattern = path.join(renditionDir, 'segment_%03d.ts');

  const command = ffmpeg(inputPath)
    .videoCodec('libx264')
    .outputOptions([
      '-y',
      `-vf ${scaleFilter(rendition.width, rendition.height)}`,
      `-preset ${preset}`,
      `-crf ${crf}`,
      `-b:v ${rendition.videoBitrate}`,
      `-maxrate ${rendition.videoBitrate}`,
      `-bufsize ${parseInt(rendition.videoBitrate, 10) * 2}k`,
      '-profile:v main',
      '-level 4.0',
      '-sc_threshold 0',
      '-g 48',
      '-keyint_min 48',
      `-hls_time ${segmentSeconds}`,
      '-hls_playlist_type vod',
      '-hls_list_size 0',
      `-hls_segment_filename ${segmentPattern}`,
      '-f hls'
    ]);

  if (hasAudio) {
    command.audioCodec('aac').audioBitrate(rendition.audioBitrate).outputOptions(['-ac 2']);
  } else {
    command.noAudio();
  }

  await new Promise<void>((resolve, reject) => {
    command.save(playlistPath).on('end', resolve).on('error', reject);
  });

  return {
    ...rendition,
    path: playlistPath,
    urlPath: `${rendition.label}/index.m3u8`
  };
}

async function createMasterPlaylist(hlsDir: string, renditions: VideoRendition[]) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const rendition of renditions) {
    const bandwidth = parseInt(rendition.videoBitrate, 10) * 1000;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rendition.width}x${rendition.height}`);
    lines.push(rendition.urlPath);
  }

  const masterPath = path.join(hlsDir, 'master.m3u8');
  await fs.promises.writeFile(masterPath, `${lines.join('\n')}\n`, 'utf8');
  return masterPath;
}

async function generateBlurhash(imagePath: string): Promise<string> {
  const { data, info } = await sharp(imagePath)
    .raw()
    .ensureAlpha()
    .resize(32, 32, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
}

export async function processVideo(inputPath: string, outputDir: string, options: ProcessVideoOptions = {}): Promise<ProcessVideoResult> {
  const finalOptions = { ...DEFAULT_OPTIONS, ...options };

  if (!(await fileExists(inputPath))) {
    throw new Error(`Input video not found: ${inputPath}`);
  }

  await ensureDir(outputDir);

  const meta = await ffprobe(inputPath);
  const videoStream = getVideoStream(meta);
  const audioStream = getAudioStream(meta);

  if (!videoStream) {
    throw new Error('No video stream found');
  }

  const duration = getDuration(meta);

  if (duration <= 0) {
    throw new Error('Invalid video duration');
  }

  if (duration > finalOptions.maxDurationSeconds) {
    throw new Error(`Video duration exceeds ${finalOptions.maxDurationSeconds} seconds`);
  }

  const id = createId(inputPath);
  const filename = `${safeName(inputPath)}_${id}`;
  const videoWidth = Number(videoStream.width || 0);
  const videoHeight = Number(videoStream.height || 0);
  const aspectRatio = videoWidth && videoHeight ? Number((videoWidth / videoHeight).toFixed(4)) : 0;
  const hlsDir = path.join(outputDir, `${filename}_hls`);
  const thumbPath = path.join(outputDir, `${filename}_thumb.jpg`);
  const posterPath = path.join(outputDir, `${filename}_poster.jpg`);
  const previewPath = path.join(outputDir, `${filename}_preview.webp`);
  const compressedPath = path.join(outputDir, `${filename}_720p.mp4`);

  await ensureDir(hlsDir);

  await Promise.all([
    createThumbnail(inputPath, thumbPath, duration, finalOptions.thumbnailAtPercent),
    createPoster(inputPath, posterPath, duration),
    createPreview(inputPath, previewPath, duration)
  ]);

  const hasAudio = Boolean(audioStream);

  await createCompressedMp4(inputPath, compressedPath, 1280, 720, finalOptions.crf, finalOptions.preset, hasAudio);

  const availableRenditions = VIDEO_RENDITIONS.filter(r => r.width <= Math.max(videoWidth, videoHeight) || r.height <= Math.max(videoWidth, videoHeight));
  const selectedRenditions = availableRenditions.length ? availableRenditions : [VIDEO_RENDITIONS[0]];

  const renditions: VideoRendition[] = [];

  for (const rendition of selectedRenditions) {
    const created = await createHlsRendition(inputPath, rendition, hlsDir, finalOptions.hlsSegmentSeconds, finalOptions.crf, finalOptions.preset, hasAudio);
    renditions.push(created);
  }

  const masterPlaylist = await createMasterPlaylist(hlsDir, renditions);
  const blurhash = await generateBlurhash(thumbPath);
  const stat = await fs.promises.stat(inputPath);

  return {
    id,
    filename,
    duration: Number(duration.toFixed(2)),
    width: videoWidth,
    height: videoHeight,
    aspectRatio,
    size: stat.size,
    thumbnail: thumbPath,
    poster: posterPath,
    preview: previewPath,
    hls: masterPlaylist,
    masterPlaylist,
    mp4: compressedPath,
    renditions,
    blurhash,
    metadata: {
      codec: videoStream.codec_name,
      fps: getFps(videoStream.avg_frame_rate),
      bitrate: meta.format.bit_rate ? Number(meta.format.bit_rate) : undefined,
      audioCodec: audioStream?.codec_name,
      hasAudio,
      format: meta.format.format_name
    }
  };
}

export async function optimizeImage(buffer: Buffer, format: 'webp' | 'avif' | 'jpeg' | 'png' = 'webp'): Promise<ImageOptimizationResult> {
  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();

  const optimized = await image
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .toFormat(format, {
      quality: format === 'png' ? undefined : 82,
      progressive: format === 'jpeg' ? true : undefined,
      effort: format === 'webp' || format === 'avif' ? 5 : undefined
    } as any)
    .toBuffer();

  const outputMeta = await sharp(optimized).metadata();

  const raw = await sharp(optimized)
    .raw()
    .ensureAlpha()
    .resize(32, 32, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  const blurhash = encode(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height, 4, 4);

  return {
    buffer: optimized,
    width: outputMeta.width || metadata.width || 0,
    height: outputMeta.height || metadata.height || 0,
    format,
    size: optimized.length,
    blurhash
  };
}

export async function generateImageVariants(buffer: Buffer) {
  const base = sharp(buffer, { failOn: 'none' }).rotate();

  const [thumb, small, medium, large] = await Promise.all([
    base.clone().resize(240, 240, { fit: 'cover' }).webp({ quality: 78 }).toBuffer(),
    base.clone().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    base.clone().resize(960, 960, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),
    base.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer()
  ]);

  const raw = await sharp(small)
    .raw()
    .ensureAlpha()
    .resize(32, 32, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  return {
    thumb,
    small,
    medium,
    large,
    blurhash: encode(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height, 4, 4)
  };
}

export async function getMediaMetadata(inputPath: string) {
  const meta = await ffprobe(inputPath);
  const videoStream = getVideoStream(meta);
  const audioStream = getAudioStream(meta);

  return {
    duration: getDuration(meta),
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    codec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    hasAudio: Boolean(audioStream),
    fps: getFps(videoStream?.avg_frame_rate),
    bitrate: meta.format.bit_rate ? Number(meta.format.bit_rate) : undefined,
    format: meta.format.format_name,
    size: meta.format.size ? Number(meta.format.size) : undefined
  };
}
