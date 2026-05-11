import multer, {
  FileFilterCallback
} from 'multer';

import {
  Request
} from 'express';

// =====================================
// MAX FILE SIZE
// =====================================

const MAX_FILE_SIZE =
  50 * 1024 * 1024;

// =====================================
// ALLOWED MIME TYPES
// =====================================

const allowedMimeTypes = [
  'image/',
  'video/'
];

// =====================================
// MULTER CONFIG
// =====================================

export const upload = multer({

  storage:
    multer.memoryStorage(),

  limits: {
    fileSize:
      MAX_FILE_SIZE
  },

  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ) => {

    try {

      const isAllowed =
        allowedMimeTypes.some(
          (type) =>
            file.mimetype.startsWith(
              type
            )
        );

      if (!isAllowed) {

        return cb(
          new Error(
            'Invalid file type'
          )
        );
      }

      cb(null, true);

    } catch (error) {

      console.error(
        'Upload filter error:',
        error
      );

      cb(
        new Error(
          'Upload failed'
        )
      );
    }
  }
});
