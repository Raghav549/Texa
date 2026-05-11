import { Role } from '@prisma/client';

declare global {

  namespace Express {

    interface Request {

      userId?: string;

      role?: Role;

    }

  }

}

export {};
