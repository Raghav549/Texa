import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    namespace Multer {
      interface File {
        fieldname: string;
        originalname: string;
        encoding: string;
        mimetype: string;
        size: number;
        destination?: string;
        filename?: string;
        path?: string;
        buffer?: Buffer;
        stream?: NodeJS.ReadableStream;
      }
    }

    interface Request {
      userId?: string;
      role?: UserRole | string;
      user?: {
        id: string;
        role: UserRole | string;
        username?: string | null;
        avatarUrl?: string | null;
        isVerified?: boolean | null;
      };
      file?: Multer.File;
      files?: Multer.File[] | { [fieldname: string]: Multer.File[] };
    }
  }
}

export {};
