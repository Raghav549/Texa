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

if (!ffprobeStatic?.path) {
  throw new Error('ffprobe-static path not found');
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
  bandwidth: number;
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
    rotation?: number;
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

export type ImageVariantsResult = {
  thumb: Buffer;
  small: Buffer;
  medium: Buffer;
  large: Buffer;
  blurhash: string;
  metadata: {
    width: number;
    height: number;
    format?: string;
    size: number;
  };
};

export type MediaMetadataResult = {
  duration: number;
  width: number;
  height: number;
  codec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  fps?: number;
  bitrate?: number;
  format?: string;
  size?: number;
  rotation?: number;
};

type ProcessVideoOptions = {
  maxDurationSeconds?: number;
  thumbnailAtPercent?: number;
  hlsSegmentSeconds?: number;
  crf?: number;
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
  keepOriginalAspect?: boolean;
  publicBasePath?: string;
  maxOutputHeight?: number;
};

const DEFAULT_OPTIONS: Required<ProcessVideoOptions> = {
  maxDurationSeconds: 180,
  thumbnailAtPercent: 0.15,
  hlsSegmentSeconds: 4,
  crf: 23,
  preset: 'veryfast',
  keepOriginalAspect: true,
  publicBasePath: '',
  maxOutputHeight: 1080
};

const VIDEO_RENDITIONS = [
  { label: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k' },
  { label: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k' },
  { label: '720p', width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k' },
  { label: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' }
];

const safeName = (filePath: string) => {
  const base = path.basename(filePath, path.extname(filePath));
  return (base.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 80) || 'media').replace(/^_+|_+$/g, '') || 'media';
};

const createId = (inputPath: string) => {
  return crypto.createHash('sha1').update(`${inputPath}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`).digest('hex').slice(0, 18);
};

const ensureDir = (dir: string) => fs.promises.mkdir(dir, { recursive: true });

const fileExists = (filePath: string) => fs.promises.access(filePath, fs.constants.F_OK).then(() => true).catch(() => false);

const assertSafePath = (filePath: string) => {
  const resolved = path.resolve(filePath);
  if (!resolved || resolved.includes('\0')) throw new Error('Invalid file path');
  return resolved;
};

const toUrlPath = (filePath: string, rootDir: string, publicBasePath = '') => {
  const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
  const base = publicBasePath.replace(/\/+$/, '');
  return base ? `${base}/${relative}` : relative;
};

const parseBitrate = (value: string) => {
  const raw = String(value || '').trim().toLowerCase();
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) return 0;
  if (raw.endsWith('m')) return Math.round(num * 1000000);
  if (raw.endsWith('k')) return Math.round(num * 1000);
  return Math.round(num);
};

const ffprobe = (inputPath: string): Promise<ffmpeg.FfprobeData> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
};

const runFfmpeg = (command: ffmpeg.FfmpegCommand) => {
  return new Promise<void>((resolve, reject) => {
    command.once('end', () => resolve()).once('error', reject).run();
  });
};

const saveFfmpeg = (command: ffmpeg.FfmpegCommand, outputPath: string) => {
  return new Promise<void>((resolve, reject) => {
    command.once('end', () => resolve()).once('error', reject).save(outputPath);
  });
};

const getVideoStream = (meta: ffmpeg.FfprobeData) => meta.streams.find(stream => stream.codec_type === 'video');

const getAudioStream = (meta: ffmpeg.FfprobeData) => meta.streams.find(stream => stream.codec_type === 'audio');

const getFps = (rate?: string) => {
  if (!rate || !rate.includes('/')) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  const fps = num / den;
  return Number.isFinite(fps) ? Number(fps.toFixed(2)) : undefined;
};

const getDuration = (meta: ffmpeg.FfprobeData) => {
  const duration = Number(meta.format.duration || 0);
  return Number.isFinite(duration) ? duration : 0;
};

const getRotation = (stream: ffmpeg.FfprobeStream | undefined) => {
  const tagsRotate = Number((stream as any)?.tags?.rotate);
  const sideData = Array.isArray((stream as any)?.side_data_list) ? (stream as any).side_data_list : [];
  const sideRotation = sideData.map((item: any) => Number(item?.rotation)).find((v: number) => Number.isFinite(v));
  const rotation = Number.isFinite(tagsRotate) ? tagsRotate : Number.isFinite(sideRotation) ? sideRotation : 0;
  return ((rotation % 360) + 360) % 360;
};

const getDisplaySize = (stream: ffmpeg.FfprobeStream | undefined) => {
  const width = Number(stream?.width || 0);
  const height = Number(stream?.height || 0);
  const rotation = getRotation(stream);
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width, rotation };
  }
  return { width, height, rotation };
};

const scalePadFilter = (width: number, height: number) => {
  return `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
};

const scaleInsideFilter = (maxWidth: number, maxHeight: number) => {
  return `scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease,setsar=1,format=yuv420p`;
};

const createFrame = async (inputPath: string, outputPath: string, duration: number, percent: number, quality = 2) => {
  const timestamp = Math.max(0.1, Math.min(Math.max(0.1, duration - 0.1), duration * percent));

  try {
    await runFfmpeg(
      ffmpeg(inputPath)
        .seekInput(timestamp)
        .outputOptions(['-y', '-frames:v 1', `-q:v ${quality}`])
        .output(outputPath)
    );
  } catch {
    await runFfmpeg(
      ffmpeg(inputPath)
        .outputOptions(['-y', '-frames:v 1', `-q:v ${quality}`])
        .output(outputPath)
    );
  }

  return outputPath;
};

const createThumbnail = async (inputPath: string, outputPath: string, duration: number, percent: number) => {
  await createFrame(inputPath, outputPath, duration, percent, 2);
  await sharp(outputPath)
    .rotate()
    .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, progressive: true, mozjpeg: true })
    .toFile(`${outputPath}.tmp`);
  await fs.promises.rename(`${outputPath}.tmp`, outputPath);
  return outputPath;
};

const createPoster = async (inputPath: string, outputPath: string, duration: number) => {
  await createFrame(inputPath, outputPath, duration, 0.05, 3);
  await sharp(outputPath)
    .rotate()
    .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, progressive: true, mozjpeg: true })
    .toFile(`${outputPath}.tmp`);
  await fs.promises.rename(`${outputPath}.tmp`, outputPath);
  return outputPath;
};

const createPreview = async (inputPath: string, outputPath: string, duration: number) => {
  const start = Math.max(0, Math.min(duration * 0.2, Math.max(0, duration - 1)));
  const previewDuration = Math.min(4, Math.max(1.5, duration * 0.2));

  try {
    await saveFfmpeg(
      ffmpeg(inputPath)
        .seekInput(start)
        .duration(previewDuration)
        .outputOptions(['-y', '-vf', 'fps=12,scale=360:-2:flags=lanczos', '-loop', '0', '-an']),
      outputPath
    );
  } catch {
    await sharp(await fs.promises.readFile(await createThumbnail(inputPath, `${outputPath}.jpg`, duration, 0.2)))
      .webp({ quality: 76 })
      .toFile(outputPath);
    await fs.promises.unlink(`${outputPath}.jpg`).catch(() => {});
  }

  return outputPath;
};

const createCompressedMp4 = async (
  inputPath: string,
  outputPath: string,
  maxWidth: number,
  maxHeight: number,
  crf: number,
  preset: string,
  hasAudio: boolean
) => {
  const command = ffmpeg(inputPath)
    .videoCodec('libx264')
    .outputOptions([
      '-y',
      '-movflags',
      '+faststart',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-vf',
      scaleInsideFilter(maxWidth, maxHeight),
      '-profile:v',
      'high',
      '-level',
      '4.1',
      '-pix_fmt',
      'yuv420p'
    ]);

  if (hasAudio) {
    command.audioCodec('aac').audioBitrate('128k').outputOptions(['-ac', '2']);
  } else {
    command.noAudio();
  }

  await saveFfmpeg(command, outputPath);
  return outputPath;
};

const createHlsRendition = async (
  inputPath: string,
  rendition: Omit<VideoRendition, 'path' | 'urlPath' | 'bandwidth'>,
  outputDir: string,
  segmentSeconds: number,
  crf: number,
  preset: string,
  hasAudio: boolean
): Promise<VideoRendition> => {
  const renditionDir = path.join(outputDir, rendition.label);
  await ensureDir(renditionDir);

  const playlistPath = path.join(renditionDir, 'index.m3u8');
  const segmentPattern = path.join(renditionDir, 'segment_%03d.ts');
  const videoBandwidth = parseBitrate(rendition.videoBitrate);
  const audioBandwidth = hasAudio ? parseBitrate(rendition.audioBitrate) : 0;
  const bandwidth = videoBandwidth + audioBandwidth;

  const command = ffmpeg(inputPath)
    .videoCodec('libx264')
    .outputOptions([
      '-y',
      '-vf',
      scalePadFilter(rendition.width, rendition.height),
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-b:v',
      rendition.videoBitrate,
      '-maxrate',
      rendition.videoBitrate,
      '-bufsize',
      `${Math.max(1, Math.round(videoBandwidth / 500))}k`,
      '-profile:v',
      'main',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-sc_threshold',
      '0',
      '-g',
      String(Math.max(24, segmentSeconds * 12)),
      '-keyint_min',
      String(Math.max(24, segmentSeconds * 12)),
      '-hls_time',
      String(segmentSeconds),
      '-hls_playlist_type',
      'vod',
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      segmentPattern,
      '-f',
      'hls'
    ]);

  if (hasAudio) {
    command.audioCodec('aac').audioBitrate(rendition.audioBitrate).outputOptions(['-ac', '2']);
  } else {
    command.noAudio();
  }

  await saveFfmpeg(command, playlistPath);

  return {
    ...rendition,
    path: playlistPath,
    urlPath: `${rendition.label}/index.m3u8`,
    bandwidth
  };
};

const createMasterPlaylist = async (hlsDir: string, renditions: VideoRendition[]) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const rendition of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.bandwidth},RESOLUTION=${rendition.width}x${rendition.height},CODECS="avc1.4d401f,mp4a.40.2"`);
    lines.push(rendition.urlPath);
  }

  const masterPath = path.join(hlsDir, 'master.m3u8');
  await fs.promises.writeFile(masterPath, `${lines.join('\n')}\n`, 'utf8');
  return masterPath;
};

const generateBlurhashFromBuffer = async (buffer: Buffer): Promise<string> => {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .raw()
      .ensureAlpha()
      .resize(32, 32, { fit: 'inside' })
      .toBuffer({ resolveWithObject: true });

    return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
  } catch {
    return 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
  }
};

const generateBlurhash = async (imagePath: string): Promise<string> => {
  try {
    const buffer = await fs.promises.readFile(imagePath);
    return generateBlurhashFromBuffer(buffer);
  } catch {
    return 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
  }
};

const selectRenditions = (width: number, height: number, maxOutputHeight: number) => {
  const longest = Math.max(width, height);
  const capped = VIDEO_RENDITIONS.filter(r => r.height <= maxOutputHeight);
  const selected = capped.filter(r => r.height <= longest || r.width <= longest);
  return selected.length ? selected : [VIDEO_RENDITIONS[0]];
};

export async function processVideo(inputPath: string, outputDir: string, options: ProcessVideoOptions = {}): Promise<ProcessVideoResult> {
  const finalOptions = { ...DEFAULT_OPTIONS, ...options };
  const safeInputPath = assertSafePath(inputPath);
  const safeOutputDir = assertSafePath(outputDir);

  if (!(await fileExists(safeInputPath))) {
    throw new Error(`Input video not found: ${safeInputPath}`);
  }

  await ensureDir(safeOutputDir);

  const meta = await ffprobe(safeInputPath);
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

  const id = createId(safeInputPath);
  const filename = `${safeName(safeInputPath)}_${id}`;
  const display = getDisplaySize(videoStream);
  const videoWidth = display.width;
  const videoHeight = display.height;
  const aspectRatio = videoWidth && videoHeight ? Number((videoWidth / videoHeight).toFixed(4)) : 0;
  const hlsDir = path.join(safeOutputDir, `${filename}_hls`);
  const thumbPath = path.join(safeOutputDir, `${filename}_thumb.jpg`);
  const posterPath = path.join(safeOutputDir, `${filename}_poster.jpg`);
  const previewPath = path.join(safeOutputDir, `${filename}_preview.webp`);
  const compressedPath = path.join(safeOutputDir, `${filename}_720p.mp4`);

  await ensureDir(hlsDir);

  const hasAudio = Boolean(audioStream);

  await Promise.all([
    createThumbnail(safeInputPath, thumbPath, duration, finalOptions.thumbnailAtPercent),
    createPoster(safeInputPath, posterPath, duration),
    createPreview(safeInputPath, previewPath, duration)
  ]);

  await createCompressedMp4(safeInputPath, compressedPath, 1280, 720, finalOptions.crf, finalOptions.preset, hasAudio);

  const selectedRenditions = selectRenditions(videoWidth, videoHeight, finalOptions.maxOutputHeight);
  const renditions: VideoRendition[] = [];

  for (const rendition of selectedRenditions) {
    const created = await createHlsRendition(
      safeInputPath,
      rendition,
      hlsDir,
      finalOptions.hlsSegmentSeconds,
      finalOptions.crf,
      finalOptions.preset,
      hasAudio
    );

    renditions.push(created);
  }

  const masterPlaylist = await createMasterPlaylist(hlsDir, renditions);
  const blurhash = await generateBlurhash(thumbPath);
  const stat = await fs.promises.stat(safeInputPath);

  return {
    id,
    filename,
    duration: Number(duration.toFixed(2)),
    width: videoWidth,
    height: videoHeight,
    aspectRatio,
    size: stat.size,
    thumbnail: toUrlPath(thumbPath, safeOutputDir, finalOptions.publicBasePath),
    poster: toUrlPath(posterPath, safeOutputDir, finalOptions.publicBasePath),
    preview: toUrlPath(previewPath, safeOutputDir, finalOptions.publicBasePath),
    hls: toUrlPath(masterPlaylist, safeOutputDir, finalOptions.publicBasePath),
    masterPlaylist: toUrlPath(masterPlaylist, safeOutputDir, finalOptions.publicBasePath),
    mp4: toUrlPath(compressedPath, safeOutputDir, finalOptions.publicBasePath),
    renditions: renditions.map(r => ({
      ...r,
      path: toUrlPath(r.path, safeOutputDir, finalOptions.publicBasePath)
    })),
    blurhash,
    metadata: {
      codec: videoStream.codec_name,
      fps: getFps(videoStream.avg_frame_rate),
      bitrate: meta.format.bit_rate ? Number(meta.format.bit_rate) : undefined,
      audioCodec: audioStream?.codec_name,
      hasAudio,
      format: meta.format.format_name,
      rotation: display.rotation
    }
  };
}

export async function optimizeImage(buffer: Buffer, format: 'webp' | 'avif' | 'jpeg' | 'png' = 'webp'): Promise<ImageOptimizationResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid image buffer');
  }

  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const optimized = await image
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .toFormat(format, {
      quality: format === 'png' ? undefined : 82,
      progressive: format === 'jpeg' ? true : undefined,
      effort: format === 'webp' || format === 'avif' ? 5 : undefined,
      compressionLevel: format === 'png' ? 9 : undefined
    } as any)
    .toBuffer();

  const outputMeta = await sharp(optimized).metadata();
  const blurhash = await generateBlurhashFromBuffer(optimized);

  return {
    buffer: optimized,
    width: outputMeta.width || 0,
    height: outputMeta.height || 0,
    format,
    size: optimized.length,
    blurhash
  };
}

export async function generateImageVariants(buffer: Buffer): Promise<ImageVariantsResult> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid image buffer');
  }

  const base = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await base.metadata();

  const [thumb, small, medium, large] = await Promise.all([
    base.clone().resize(240, 240, { fit: 'cover', position: 'attention' }).webp({ quality: 78, effort: 4 }).toBuffer(),
    base.clone().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80, effort: 4 }).toBuffer(),
    base.clone().resize(960, 960, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 5 }).toBuffer(),
    base.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 84, effort: 5 }).toBuffer()
  ]);

  const blurhash = await generateBlurhashFromBuffer(small);
  const largeMeta = await sharp(large).metadata();

  return {
    thumb,
    small,
    medium,
    large,
    blurhash,
    metadata: {
      width: largeMeta.width || metadata.width || 0,
      height: largeMeta.height || metadata.height || 0,
      format: metadata.format,
      size: buffer.length
    }
  };
}

export async function getMediaMetadata(inputPath: string): Promise<MediaMetadataResult> {
  const safeInputPath = assertSafePath(inputPath);

  if (!(await fileExists(safeInputPath))) {
    throw new Error(`Input media not found: ${safeInputPath}`);
  }

  const meta = await ffprobe(safeInputPath);
  const videoStream = getVideoStream(meta);
  const audioStream = getAudioStream(meta);
  const display = getDisplaySize(videoStream);

  return {
    duration: getDuration(meta),
    width: display.width || 0,
    height: display.height || 0,
    codec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    hasAudio: Boolean(audioStream),
    fps: getFps(videoStream?.avg_frame_rate),
    bitrate: meta.format.bit_rate ? Number(meta.format.bit_rate) : undefined,
    format: meta.format.format_name,
    size: meta.format.size ? Number(meta.format.size) : undefined,
    rotation: display.rotation
  };
}

export async function removeProcessedMedia(paths: string[]) {
  const results = await Promise.allSettled(
    paths.filter(Boolean).map(async item => {
      const resolved = assertSafePath(item);
      const stat = await fs.promises.stat(resolved).catch(() => null);
      if (!stat) return false;
      if (stat.isDirectory()) await fs.promises.rm(resolved, { recursive: true, force: true });
      else await fs.promises.unlink(resolved).catch(() => {});
      return true;
    })
  );

  return {
    removed: results.filter(r => r.status === 'fulfilled' && r.value).length,
    failed: results.filter(r => r.status === 'rejected').length
  };
}
