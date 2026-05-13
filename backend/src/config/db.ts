import { PrismaClient, Prisma } from '@prisma/client';

const prismaClientOptions: Prisma.PrismaClientOptions = {
  log:
    process.env.NODE_ENV === 'development'
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' }
        ]
      : [{ emit: 'stdout', level: 'error' }],
  errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'pretty'
};

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(prismaClientOptions);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (event) => {
    if (process.env.PRISMA_QUERY_LOG === 'true') {
      console.log({
        query: event.query,
        params: event.params,
        duration: `${event.duration}ms`
      });
    }
  });
}

export const connectDatabase = async () => {
  try {
    await prisma.$connect();
    return true;
  } catch (error) {
    console.error('DATABASE_CONNECTION_FAILED', error);
    throw error;
  }
};

export const disconnectDatabase = async () => {
  try {
    await prisma.$disconnect();
    return true;
  } catch (error) {
    console.error('DATABASE_DISCONNECT_FAILED', error);
    throw error;
  }
};

export const databaseHealthCheck = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      connected: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      connected: false,
      timestamp: new Date().toISOString()
    };
  }
};

export const withTransaction = async <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  }
): Promise<T> => {
  return prisma.$transaction(callback, {
    maxWait: options?.maxWait ?? 5000,
    timeout: options?.timeout ?? 15000,
    isolationLevel: options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted
  });
};

export default prisma;
