import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  deleteFromS3,
  getObjectMeta,
  getPresignedUploadUrl,
  uploadFileToS3,
  uploadManyToS3
} from '../services/storage';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 250 * 1024 * 1024),
    files: 10
  }
});

router.post('/single', authMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('file is required');

    const result = await uploadFileToS3(
      {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        metadata: {
          userId: (req as any).user?.id
        }
      },
      {
        folder: String(req.body.folder || 'uploads'),
        preserveName: true,
        publicRead: req.body.publicRead === 'true',
        private: req.body.private === 'true'
      }
    );

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.post('/many', authMiddleware, upload.array('files', 10), async (req, res, next) => {
  try {
    const files = (req.files || []) as Express.Multer.File[];
    if (!files.length) throw new Error('files are required');

    const result = await uploadManyToS3(
      files.map((file) => ({
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        metadata: {
          userId: (req as any).user?.id
        }
      })),
      String(req.body.folder || 'uploads'),
      {
        preserveName: true,
        publicRead: req.body.publicRead === 'true',
        private: req.body.private === 'true'
      }
    );

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.post('/presigned', authMiddleware, async (req, res, next) => {
  try {
    const { key, contentType, expiresMin, folder, filename } = req.body;
    const finalKey = key || `${folder || 'uploads'}/${Date.now()}-${filename || 'file'}`;

    const result = await getPresignedUploadUrl(finalKey, contentType || 'application/octet-stream', Number(expiresMin || 15), {
      private: req.body.private === true || req.body.private === 'true',
      metadata: {
        userId: (req as any).user?.id
      }
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/meta', authMiddleware, async (req, res, next) => {
  try {
    const result = await getObjectMeta(String(req.query.key || ''));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.delete('/', authMiddleware, async (req, res, next) => {
  try {
    const result = await deleteFromS3(String(req.body.key || req.query.key || ''));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

export default router;
