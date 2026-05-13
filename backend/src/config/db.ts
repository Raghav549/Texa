import { PrismaClient, Prisma } from '@prisma/client';

const NODE_ENV = process.env.NODE_ENV || 'development';
const isDevelopment = NODE_ENV === 'development';
const isProduction = NODE_ENV === 'production';

const prismaClientOptions: Prisma.PrismaClientOptions = {
  log: isDevelopment
    ? [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' }
      ]
    : [{ emit: 'stdout', level: 'error' }],
  errorFormat: isProduction ? 'minimal' : 'pretty'
};

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaClientOptions);

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

if (isDevelopment) {
  prisma.$on('query', event => {
    if (process.env.PRISMA_QUERY_LOG === 'true') {
      console.log(
        JSON.stringify(
          {
            level: 'query',
            query: event.query,
            params: event.params,
            duration: `${event.duration}ms`,
            timestamp: event.timestamp.toISOString()
          },
          null,
          2
        )
      );
    }
  });
}

let databaseConnected = false;
let databaseConnecting: Promise<boolean> | null = null;

export const connectDatabase = async (): Promise<boolean> => {
  if (databaseConnected) return true;

  if (databaseConnecting) return databaseConnecting;

  databaseConnecting = prisma
    .$connect()
    .then(async () => {
      await prisma.$queryRaw`SELECT 1`;
      databaseConnected = true;
      databaseConnecting = null;
      return true;
    })
    .catch(error => {
      databaseConnected = false;
      databaseConnecting = null;
      console.error(
        JSON.stringify(
          {
            level: 'error',
            code: 'DATABASE_CONNECTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            stack: isProduction || !(error instanceof Error) ? undefined : error.stack,
            timestamp: new Date().toISOString()
          },
          null,
          2
        )
      );
      throw error;
    });

  return databaseConnecting;
};

export const disconnectDatabase = async (): Promise<boolean> => {
  try {
    if (!databaseConnected) {
      await prisma.$disconnect();
      return true;
    }

    await prisma.$disconnect();
    databaseConnected = false;
    databaseConnecting = null;
    return true;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          level: 'error',
          code: 'DATABASE_DISCONNECT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          stack: isProduction || !(error instanceof Error) ? undefined : error.stack,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    );
    throw error;
  }
};

export const databaseHealthCheck = async (): Promise<{
  status: 'ok' | 'error';
  connected: boolean;
  latencyMs: number;
  timestamp: string;
}> => {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;

    return {
      status: 'ok',
      connected: true,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    };
  } catch {
    return {
      status: 'error',
      connected: false,
      latencyMs: Date.now() - startedAt,
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
    maxWait: options?.maxWait ?? Number(process.env.PRISMA_TRANSACTION_MAX_WAIT || 5000),
    timeout: options?.timeout ?? Number(process.env.PRISMA_TRANSACTION_TIMEOUT || 15000),
    isolationLevel:
      options?.isolationLevel ??
      (process.env.PRISMA_TRANSACTION_ISOLATION_LEVEL as Prisma.TransactionIsolationLevel | undefined) ??
      Prisma.TransactionIsolationLevel.ReadCommitted
  });
};

export const isDatabaseConnected = (): boolean => databaseConnected;

export const getDatabaseClient = (): PrismaClient => prisma;

export default prisma;
