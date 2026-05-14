import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      role?: UserRole | string;
      user?: {
        id: string;
        role: UserRole;
        username?: string | null;
        avatarUrl?: string | null;
        isVerified?: boolean | null;
      };
    }
  }
}

export {};
