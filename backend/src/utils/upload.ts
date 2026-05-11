import {

  S3Client,
  PutObjectCommand

} from '@aws-sdk/client-s3';

import { v4 as uuid } from 'uuid';

import path from 'path';

// ============================================
// ENV VALIDATION
// ============================================

if (

  !process.env.AWS_REGION ||
  !process.env.AWS_ACCESS_KEY ||
  !process.env.AWS_SECRET_KEY ||
  !process.env.AWS_BUCKET

) {

  throw new Error(

    'Missing AWS S3 environment variables'

  );

}

// ============================================
// S3 CLIENT
// ============================================

export const s3 = new S3Client({

  region: process.env.AWS_REGION,

  credentials: {

    accessKeyId:
      process.env.AWS_ACCESS_KEY,

    secretAccessKey:
      process.env.AWS_SECRET_KEY,

  },

});

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
// SANITIZE FILE NAME
// ============================================

const sanitizeFileName = (

  filename: string

) => {

  return filename

    .replace(/\s+/g, '-')

    .replace(/[^a-zA-Z0-9.\-_]/g, '');

};

// ============================================
// UPLOAD FILE
// ============================================

export const uploadFile = async (

  file: Express.Multer.File,

  folder: string

): Promise<string> => {

  try {

    // ============================================
    // FILE CHECK
    // ============================================

    if (!file) {

      throw new Error(

        'No file uploaded'

      );

    }

    // ============================================
    // MIME VALIDATION
    // ============================================

    if (

      !allowedMimeTypes.includes(

        file.mimetype

      )

    ) {

      throw new Error(

        'Unsupported file type'

      );

    }

    // ============================================
    // FILE EXTENSION
    // ============================================

    const ext = path.extname(

      file.originalname

    ).toLowerCase();

    // ============================================
    // SAFE FILE NAME
    // ============================================

    const safeName = sanitizeFileName(

      path.basename(

        file.originalname,

        ext

      )

    );

    // ============================================
    // UNIQUE KEY
    // ============================================

    const key =

      `${folder}/${uuid()}_${safeName}${ext}`;

    // ============================================
    // UPLOAD TO S3
    // ============================================

    await s3.send(

      new PutObjectCommand({

        Bucket:
          process.env.AWS_BUCKET,

        Key: key,

        Body: file.buffer,

        ContentType:
          file.mimetype,

      })

    );

    // ============================================
    // PUBLIC URL
    // ============================================

    const fileUrl =

      `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    console.log(

      'S3 Upload Success:',

      fileUrl

    );

    return fileUrl;

  } catch (error) {

    console.error(

      'S3 Upload Error:',

      error

    );

    throw new Error(

      'Failed to upload file'

    );

  }

};
