import multer, { FileFilterCallback, MulterError } from 'multer';
import { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';

type UploadValidationResult = {
  valid: boolean;
  error?: string;
};

type UploadPreset = 'image' | 'video' | 'audio' | 'document' | 'media' | 'story' | 'reel' | 'product' | 'store' | 'chat' | 'any';

const MB = 1024 * 1024;

const IMAGE_MAX_SIZE = Number(process.env.IMAGE_MAX_SIZE || 25 * MB);
const VIDEO_MAX_SIZE = Number(process.env.VIDEO_MAX_SIZE || 250 * MB);
const AUDIO_MAX_SIZE = Number(process.env.AUDIO_MAX_SIZE || 50 * MB);
const DOCUMENT_MAX_SIZE = Number(process.env.DOCUMENT_MAX_SIZE || 25 * MB);
const DEFAULT_MAX_SIZE = Number(process.env.UPLOAD_MAX_SIZE || VIDEO_MAX_SIZE);

const MAX_FILES_DEFAULT = Number(process.env.UPLOAD_MAX_FILES || 12);
const MAX_FIELD_SIZE = Number(process.env.UPLOAD_MAX_FIELD_SIZE || 2 * MB);
const MAX_FIELDS = Number(process.env.UPLOAD_MAX_FIELDS || 80);
const MAX_PARTS = Number(process.env.UPLOAD_MAX_PARTS || 120);

const imageMimeTypes = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif'
]);

const videoMimeTypes = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/mpeg',
  'video/ogg'
]);

const audioMimeTypes = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a'
]);

const documentMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

const dangerousExtensions = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.php',
  '.phtml',
  '.phar',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.htm',
  '.svg',
  '.xml',
  '.jar',
  '.apk',
  '.ipa',
  '.dll',
  '.so',
  '.dylib',
  '.msi',
  '.scr',
  '.vbs',
  '.wsf',
  '.com',
  '.reg',
  '.lnk'
]);

const extensionMimeMap: Record<string, Set<string>> = {
  '.jpg': new Set(['image/jpeg', 'image/jpg']),
  '.jpeg': new Set(['image/jpeg', 'image/jpg']),
  '.png': new Set(['image/png']),
  '.webp': new Set(['image/webp']),
  '.gif': new Set(['image/gif']),
  '.avif': new Set(['image/avif']),
  '.heic': new Set(['image/heic', 'image/heif']),
  '.heif': new Set(['image/heif', 'image/heic']),
  '.mp4': new Set(['video/mp4', 'audio/mp4']),
  '.webm': new Set(['video/webm', 'audio/webm']),
  '.mov': new Set(['video/quicktime']),
  '.mkv': new Set(['video/x-matroska']),
  '.mpeg': new Set(['video/mpeg']),
  '.mpg': new Set(['video/mpeg']),
  '.ogg': new Set(['video/ogg', 'audio/ogg']),
  '.mp3': new Set(['audio/mpeg', 'audio/mp3']),
  '.wav': new Set(['audio/wav']),
  '.aac': new Set(['audio/aac']),
  '.m4a': new Set(['audio/mp4', 'audio/x-m4a']),
  '.pdf': new Set(['application/pdf']),
  '.txt': new Set(['text/plain']),
  '.csv': new Set(['text/csv']),
  '.json': new Set(['application/json']),
  '.doc': new Set(['application/msword']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  '.xls': new Set(['application/vnd.ms-excel']),
  '.xlsx': new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  '.ppt': new Set(['application/vnd.ms-powerpoint']),
  '.pptx': new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation'])
};

const presetMimeTypes: Record<UploadPreset, Set<string>> = {
  image: imageMimeTypes,
  video: videoMimeTypes,
  audio: audioMimeTypes,
  document: documentMimeTypes,
  media: new Set([...imageMimeTypes, ...videoMimeTypes]),
  story: new Set([...imageMimeTypes, ...videoMimeTypes]),
  reel: videoMimeTypes,
  product: imageMimeTypes,
  store: imageMimeTypes,
  chat: new Set([...imageMimeTypes, ...videoMimeTypes, ...audioMimeTypes, ...documentMimeTypes]),
  any: new Set([...imageMimeTypes, ...videoMimeTypes, ...audioMimeTypes, ...documentMimeTypes])
};

const presetMaxSize: Record<UploadPreset, number> = {
  image: IMAGE_MAX_SIZE,
  video: VIDEO_MAX_SIZE,
  audio: AUDIO_MAX_SIZE,
  document: DOCUMENT_MAX_SIZE,
  media: VIDEO_MAX_SIZE,
  story: VIDEO_MAX_SIZE,
  reel: VIDEO_MAX_SIZE,
  product: IMAGE_MAX_SIZE,
  store: IMAGE_MAX_SIZE,
  chat: DEFAULT_MAX_SIZE,
  any: DEFAULT_MAX_SIZE
};

const normalizeOriginalName = (name: string) => {
  const parsed = path.parse(name || 'file');
  const ext = parsed.ext.toLowerCase();
  const base = parsed.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${base || 'file'}${ext}`;
};

const getExtension = (file: Express.Multer.File) => {
  return path.extname(file.originalname || '').toLowerCase();
};

const getPresetFromRequest = (req: Request): UploadPreset => {
  const fromQuery = typeof req.query.uploadPreset === 'string' ? req.query.uploadPreset : undefined;
  const fromBody = typeof req.body?.uploadPreset === 'string' ? req.body.uploadPreset : undefined;
  const fromHeader = typeof req.headers['x-upload-preset'] === 'string' ? req.headers['x-upload-preset'] : undefined;
  const preset = String(fromQuery || fromBody || fromHeader || 'any').toLowerCase();

  if (
    preset === 'image' ||
    preset === 'video' ||
    preset === 'audio' ||
    preset === 'document' ||
    preset === 'media' ||
    preset === 'story' ||
    preset === 'reel' ||
    preset === 'product' ||
    preset === 'store' ||
    preset === 'chat' ||
    preset === 'any'
  ) {
    return preset;
  }

  return 'any';
};

const isAllowedMimeForPreset = (preset: UploadPreset, mimetype: string) => {
  return presetMimeTypes[preset].has(mimetype);
};

const validateExtension = (file: Express.Multer.File, preset: UploadPreset) => {
  const ext = getExtension(file);

  if (!ext) return false;
  if (dangerousExtensions.has(ext)) return false;

  const allowedForExt = extensionMimeMap[ext];

  if (!allowedForExt) {
    return preset === 'any' && presetMimeTypes.any.has(file.mimetype);
  }

  if (!allowedForExt.has(file.mimetype)) {
    if (file.mimetype === 'image/jpg' && ext === '.jpg') return true;
    return false;
  }

  return true;
};

const validateFileByPreset = (file: Express.Multer.File, preset: UploadPreset): UploadValidationResult => {
  if (!file) {
    return {
      valid: false,
      error: 'No file uploaded'
    };
  }

  if (!file.originalname || file.originalname.length > 180) {
    return {
      valid: false,
      error: 'Invalid file name'
    };
  }

  if (!file.mimetype || typeof file.mimetype !== 'string') {
    return {
      valid: false,
      error: 'Invalid file type'
    };
  }

  if (!isAllowedMimeForPreset(preset, file.mimetype)) {
    return {
      valid: false,
      error: 'Unsupported file format'
    };
  }

  if (!validateExtension(file, preset)) {
    return {
      valid: false,
      error: 'File extension does not match file type'
    };
  }

  const maxSize = presetMaxSize[preset];

  if (file.size > maxSize) {
    return {
      valid: false,
      error: `File size exceeds ${Math.floor(maxSize / MB)}MB limit`
    };
  }

  if (file.size <= 0) {
    return {
      valid: false,
      error: 'Empty file is not allowed'
    };
  }

  return {
    valid: true
  };
};

const fileFilter = (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  try {
    const preset = getPresetFromRequest(req);
    file.originalname = normalizeOriginalName(file.originalname);
    const result = validateFileByPreset(file, preset);

    if (!result.valid) {
      return cb(new Error(result.error || 'File upload validation failed'));
    }

    cb(null, true);
  } catch {
    cb(new Error('File upload validation failed'));
  }
};

const storage = multer.memoryStorage();

const createUpload = (preset: UploadPreset = 'any', maxFiles = MAX_FILES_DEFAULT, maxSize?: number) => {
  return multer({
    storage,
    limits: {
      fileSize: maxSize || presetMaxSize[preset],
      files: maxFiles,
      fieldSize: MAX_FIELD_SIZE,
      fields: MAX_FIELDS,
      parts: MAX_PARTS
    },
    fileFilter(req, file, cb) {
      try {
        (req as any).query = {
          ...req.query,
          uploadPreset: preset
        };

        file.originalname = normalizeOriginalName(file.originalname);
        const result = validateFileByPreset(file, preset);

        if (!result.valid) {
          return cb(new Error(result.error || 'File upload validation failed'));
        }

        cb(null, true);
      } catch {
        cb(new Error('File upload validation failed'));
      }
    }
  });
};

export const upload = multer({
  storage,
  limits: {
    fileSize: DEFAULT_MAX_SIZE,
    files: MAX_FILES_DEFAULT,
    fieldSize: MAX_FIELD_SIZE,
    fields: MAX_FIELDS,
    parts: MAX_PARTS
  },
  fileFilter
});

export const imageUpload = createUpload('image', 8, IMAGE_MAX_SIZE);

export const videoUpload = createUpload('video', 2, VIDEO_MAX_SIZE);

export const audioUpload = createUpload('audio', 3, AUDIO_MAX_SIZE);

export const documentUpload = createUpload('document', 5, DOCUMENT_MAX_SIZE);

export const mediaUpload = createUpload('media', 8, VIDEO_MAX_SIZE);

export const storyUpload = createUpload('story', 1, VIDEO_MAX_SIZE);

export const reelUpload = createUpload('reel', 1, VIDEO_MAX_SIZE);

export const productUpload = createUpload('product', 12, IMAGE_MAX_SIZE);

export const storeUpload = createUpload('store', 14, IMAGE_MAX_SIZE);

export const chatUpload = createUpload('chat', 6, DEFAULT_MAX_SIZE);

export const uploadSingle = (fieldName = 'file', preset: UploadPreset = 'any') => {
  return createUpload(preset, 1).single(fieldName);
};

export const uploadArray = (fieldName = 'files', maxCount = MAX_FILES_DEFAULT, preset: UploadPreset = 'any') => {
  return createUpload(preset, maxCount).array(fieldName, maxCount);
};

export const uploadFields = (
  fields: {
    name: string;
    maxCount: number;
  }[],
  preset: UploadPreset = 'any'
) => {
  const maxFiles = fields.reduce((sum, field) => sum + field.maxCount, 0);
  return createUpload(preset, maxFiles).fields(fields);
};

export const storeUploadFields = storeUpload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'gallery', maxCount: 12 }
]);

export const productUploadFields = productUpload.fields([
  { name: 'images', maxCount: 12 },
  { name: 'thumbnail', maxCount: 1 }
]);

export const profileUploadFields = imageUpload.fields([
  { name: 'avatar', maxCount: 1 },
  { name: 'cover', maxCount: 1 }
]);

export const chatUploadFields = chatUpload.fields([
  { name: 'media', maxCount: 6 },
  { name: 'attachments', maxCount: 6 },
  { name: 'voice', maxCount: 1 }
]);

export const validateUploadedFile = (file?: Express.Multer.File, preset: UploadPreset = 'any'): UploadValidationResult => {
  return validateFileByPreset(file as Express.Multer.File, preset);
};

export const validateUploadedFiles = (files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>, preset: UploadPreset = 'any'): UploadValidationResult => {
  if (!files) {
    return {
      valid: false,
      error: 'No files uploaded'
    };
  }

  const list = Array.isArray(files) ? files : Object.values(files).flat();

  if (!list.length) {
    return {
      valid: false,
      error: 'No files uploaded'
    };
  }

  for (const file of list) {
    const result = validateUploadedFile(file, preset);
    if (!result.valid) return result;
  }

  return {
    valid: true
  };
};

export const getUploadedFiles = (req: Request, fieldName?: string): Express.Multer.File[] => {
  if (req.file) return [req.file];

  if (Array.isArray(req.files)) {
    if (!fieldName) return req.files;
    return req.files.filter(file => file.fieldname === fieldName);
  }

  if (req.files && typeof req.files === 'object') {
    if (fieldName) return (req.files as Record<string, Express.Multer.File[]>)[fieldName] || [];
    return Object.values(req.files as Record<string, Express.Multer.File[]>).flat();
  }

  return [];
};

export const getFirstUploadedFile = (req: Request, fieldName?: string): Express.Multer.File | undefined => {
  return getUploadedFiles(req, fieldName)[0];
};

export const buildSafeFileName = (file: Express.Multer.File, prefix = 'upload') => {
  const ext = getExtension(file) || '';
  const stamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `${prefix}-${stamp}-${random}${ext}`;
};

export const uploadErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();

  if (err instanceof MulterError) {
    const messages: Record<string, string> = {
      LIMIT_PART_COUNT: 'Too many upload parts',
      LIMIT_FILE_SIZE: 'File size limit exceeded',
      LIMIT_FILE_COUNT: 'Too many files uploaded',
      LIMIT_FIELD_KEY: 'Field name is too long',
      LIMIT_FIELD_VALUE: 'Field value is too long',
      LIMIT_FIELD_COUNT: 'Too many fields',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field'
    };

    return res.status(400).json({
      success: false,
      error: messages[err.code] || err.message || 'Upload failed',
      code: err.code,
      requestId: req.requestId
    });
  }

  if (err.message) {
    return res.status(400).json({
      success: false,
      error: err.message,
      requestId: req.requestId
    });
  }

  return res.status(400).json({
    success: false,
    error: 'Upload failed',
    requestId: req.requestId
  });
};

export {
  IMAGE_MAX_SIZE,
  VIDEO_MAX_SIZE,
  AUDIO_MAX_SIZE,
  DOCUMENT_MAX_SIZE,
  DEFAULT_MAX_SIZE,
  imageMimeTypes,
  videoMimeTypes,
  audioMimeTypes,
  documentMimeTypes
};
