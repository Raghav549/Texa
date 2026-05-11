import multer, {

  FileFilterCallback

} from 'multer';

import { Request } from 'express';

// ============================================
// FILE SIZE LIMITS
// ============================================

const IMAGE_MAX_SIZE =

  10 * 1024 * 1024;

const VIDEO_MAX_SIZE =

  50 * 1024 * 1024;

// ============================================
// ALLOWED MIME TYPES
// ============================================

const allowedMimeTypes = [

  'image/jpeg',
  'image/png',
  'image/webp',

  'video/mp4',
  'video/webm',
  'video/quicktime',

];

// ============================================
// FILE FILTER
// ============================================

const fileFilter = (

  _req: Request,

  file: Express.Multer.File,

  cb: FileFilterCallback

) => {

  try {

    // ============================================
    // MIME TYPE VALIDATION
    // ============================================

    const isAllowed =

      allowedMimeTypes.includes(

        file.mimetype

      );

    if (!isAllowed) {

      return cb(

        new Error(

          'Unsupported file format'

        )

      );

    }

    // ============================================
    // FILE NAME VALIDATION
    // ============================================

    const invalidPattern =

      /\.(exe|bat|sh|cmd|php|js|ts)$/i;

    if (

      invalidPattern.test(

        file.originalname

      )

    ) {

      return cb(

        new Error(

          'Dangerous file detected'

        )

      );

    }

    cb(null, true);

  } catch (error) {

    console.error(

      'Upload File Filter Error:',

      error

    );

    return cb(

      new Error(

        'File upload validation failed'

      )

    );

  }

};

// ============================================
// MULTER CONFIG
// ============================================

export const upload = multer({

  storage: multer.memoryStorage(),

  limits: {

    fileSize: VIDEO_MAX_SIZE,

    files: 1,

  },

  fileFilter,

});

// ============================================
// FILE SIZE VALIDATOR
// ============================================

export const validateUploadedFile = (

  file?: Express.Multer.File

) => {

  if (!file) {

    return {

      valid: false,

      error: 'No file uploaded',

    };

  }

  // ============================================
  // IMAGE SIZE VALIDATION
  // ============================================

  if (

    file.mimetype.startsWith(

      'image/'

    ) &&

    file.size > IMAGE_MAX_SIZE

  ) {

    return {

      valid: false,

      error:
        'Image size exceeds 10MB limit',

    };

  }

  // ============================================
  // VIDEO SIZE VALIDATION
  // ============================================

  if (

    file.mimetype.startsWith(

      'video/'

    ) &&

    file.size > VIDEO_MAX_SIZE

  ) {

    return {

      valid: false,

      error:
        'Video size exceeds 50MB limit',

    };

  }

  return {

    valid: true,

  };

};
