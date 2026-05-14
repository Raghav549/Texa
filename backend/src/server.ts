import express, { Application, NextFunction, Request, Response } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import compression from 'compression';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { ZodError } from 'zod';
import routes from './routes';
import { prisma } from './config/db';
import {
  redis,
  initRedisAdapter,
  connectRedis,
  closeRedisConnections,
  redisHealthCheck
} from './config/redis';
import { initVoiceNamespace } from './sockets/voice';
import { applySecurity } from './middleware/security';
import { apiLimiter } from './middleware/rateLimit';
import { initWorkers } from './workers';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      startedAt?: number;
      clientIp?: string;
    }
  }
}

type ServerState = {
  startedAt: number;
  shuttingDown: boolean;
  prismaReady: boolean;
  redisReady: boolean;
  workersReady: boolean;
  socketsReady: boolean;
  httpReady: boolean;
};

type NormalizedError = {
  status: number;
  code: string;
  message: string;
};

type WorkerController = {
  close?: () => Promise<any> | any;
  shutdown?: () => Promise<any> | any;
  stop?: () => Promise<any> | any;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const IS_TEST = NODE_ENV === 'test';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = process.env.BODY_LIMIT || '25mb';
const URL_LIMIT = process.env.URL_LIMIT || '25mb';
const SOCKET_BUFFER_SIZE = Number(process.env.SOCKET_BUFFER_SIZE || 10 * 1024 * 1024);
const SOCKET_PING_TIMEOUT = Number(process.env.SOCKET_PING_TIMEOUT || 60_000);
const SOCKET_PING_INTERVAL = Number(process.env.SOCKET_PING_INTERVAL || 25_000);
const SOCKET_CONNECT_TIMEOUT = Number(process.env.SOCKET_CONNECT_TIMEOUT || 45_000);
const SOCKET_RECOVERY_MS = Number(process.env.SOCKET_RECOVERY_MS || 120_000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);
const APP_NAME = process.env.APP_NAME || 'Texa Universe API';
const APP_VERSION = process.env.APP_VERSION || process.env.npm_package_version || '1.0.0';
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;

const state: ServerState = {
  startedAt: Date.now(),
  shuttingDown: false,
  prismaReady: false,
  redisReady: false,
  workersReady: false,
  socketsReady: false,
  httpReady: false
};

let workerController: WorkerController | null = null;

const app: Application = express();
const server: HttpServer = createServer(app);

const parseOrigins = (): CorsOptions['origin'] => {
  const raw = process.env.CORS_ORIGIN || process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || '';
  const list = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (!list.length) return IS_PROD ? false : true;
  if (list.includes('*')) return true;

  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (list.includes(origin)) return callback(null, true);

    try {
      const parsed = new URL(origin);
      const normalized = `${parsed.protocol}//${parsed.host}`;
      if (list.includes(normalized)) return callback(null, true);
    } catch {}

    return callback(new Error(`CORS origin blocked: ${origin}`));
  };
};

const allowedOrigins = parseOrigins();

const corsOptions: CorsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Request-Id',
    'X-Client-Version',
    'X-Device-Id',
    'X-App-Version',
    'X-Platform',
    'X-Socket-Id'
  ],
  exposedHeaders: ['X-Request-Id', 'X-Response-Time', 'X-App-Version'],
  maxAge: 86_400,
  optionsSuccessStatus: 204
};

const io = new SocketServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  },
  pingTimeout: SOCKET_PING_TIMEOUT,
  pingInterval: SOCKET_PING_INTERVAL,
  connectTimeout: SOCKET_CONNECT_TIMEOUT,
  maxHttpBufferSize: SOCKET_BUFFER_SIZE,
  transports: ['websocket', 'polling'],
  allowEIO3: false,
  serveClient: false,
  connectionStateRecovery: {
    maxDisconnectionDuration: SOCKET_RECOVERY_MS,
    skipMiddlewares: true
  }
});

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const createRequestId = () => `req_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

const getClientIp = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || req.ip;
  if (Array.isArray(forwarded)) return forwarded[0] || req.ip;
  return req.ip;
};

const normalizeError = (err: any): NormalizedError => {
  const rawStatus =
    Number(err?.statusCode) ||
    Number(err?.status) ||
    Number(err?.response?.status) ||
    (err?.type === 'entity.too.large' ? 413 : 0) ||
    500;

  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;

  const message =
    status >= 500 && IS_PROD
      ? 'Internal Server Error'
      : String(err?.message || 'Internal Server Error');

  const code = String(
    err?.code ||
      err?.name ||
      (status === 400
        ? 'BAD_REQUEST'
        : status === 401
          ? 'UNAUTHORIZED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : status === 413
                  ? 'PAYLOAD_TOO_LARGE'
                  : status === 429
                    ? 'RATE_LIMITED'
                    : 'SERVER_ERROR')
  ).toUpperCase();

  return { status, code, message };
};

const connectPrisma = async () => {
  if (state.prismaReady) return;
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  state.prismaReady = true;
};

const connectRedisClients = async () => {
  if (state.redisReady) return;

  await connectRedis();

  const client: any = redis as any;

  if (typeof client?.ping === 'function') {
    await client.ping();
  }

  state.redisReady = true;
};

const startWorkers = async () => {
  if (state.workersReady) return;

  if (process.env.ENABLE_WORKERS === 'false') {
    state.workersReady = true;
    return;
  }

  const result = await Promise.resolve(initWorkers());

  if (result && typeof result === 'object') {
    workerController = result as WorkerController;
  }

  state.workersReady = true;
};

const closeWorkers = async () => {
  if (!state.workersReady) return;

  const controller: any = workerController;

  if (controller?.close && typeof controller.close === 'function') {
    await controller.close();
  } else if (controller?.shutdown && typeof controller.shutdown === 'function') {
    await controller.shutdown();
  } else if (controller?.stop && typeof controller.stop === 'function') {
    await controller.stop();
  }

  workerController = null;
  state.workersReady = false;
};

const initSockets = async () => {
  if (state.socketsReady) return;
  await Promise.resolve(initRedisAdapter(io));
  await Promise.resolve(initVoiceNamespace(io));
  state.socketsReady = true;
};

const closeHttpServer = () =>
  new Promise<void>(resolve => {
    if (!state.httpReady) return resolve();
    server.close(() => resolve());
  });

const closeSocketServer = () =>
  new Promise<void>(resolve => {
    if (!state.socketsReady) return resolve();
    io.close(() => resolve());
  });

app.disable('x-powered-by');
app.set('trust proxy', 1);

applySecurity(app);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: IS_PROD
      ? {
          useDefaults: true,
          directives: {
            'default-src': ["'self'"],
            'img-src': ["'self'", 'data:', 'blob:', 'https:'],
            'media-src': ["'self'", 'data:', 'blob:', 'https:'],
            'connect-src': ["'self'", 'https:', 'wss:', 'ws:'],
            'script-src': ["'self'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'font-src': ["'self'", 'data:', 'https:'],
            'object-src': ["'none'"],
            'base-uri': ["'self'"],
            'frame-ancestors': ["'none'"]
          }
        }
      : false
  })
);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(compression({ threshold: 1024 }));
app.use(cookieParser());
app.use(express.json({ limit: BODY_LIMIT, strict: true }));
app.use(express.urlencoded({ extended: true, limit: URL_LIMIT }));

app.use((req: Request, res: Response, next: NextFunction) => {
  req.id = String(req.headers['x-request-id'] || createRequestId());
  req.startedAt = Date.now();
  req.clientIp = getClientIp(req);
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-App-Version', APP_VERSION);
  next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (!res.headersSent && req.startedAt) {
      res.setHeader('X-Response-Time', `${Date.now() - req.startedAt}ms`);
    }
    return originalJson(body);
  };
  next();
});

app.use(apiLimiter);

if (!IS_TEST) {
  app.use(
    morgan(IS_PROD ? 'combined' : ':method :url :status :res[content-length] - :response-time ms', {
      skip: req =>
        req.url === '/' ||
        req.url === '/health' ||
        req.url === '/api/health' ||
        req.url === '/ready'
    })
  );
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!state.shuttingDown) return next();

  return res.status(503).json({
    success: false,
    ok: false,
    error: 'Server is shutting down',
    code: 'SERVER_SHUTTING_DOWN',
    requestId: req.id
  });
});

app.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      ok: true,
      name: APP_NAME,
      status: 'running',
      version: APP_VERSION,
      environment: NODE_ENV,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  })
);

app.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response) => {
    let database = state.prismaReady;
    let cache = state.redisReady;
    let redisStatus: any = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }

    if (state.redisReady) {
      try {
        redisStatus = await redisHealthCheck();
        cache = true;
      } catch {
        redisStatus = null;
        cache = false;
      }
    }

    const healthy = database && cache && state.socketsReady && state.httpReady && !state.shuttingDown;

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      ok: healthy,
      status: healthy ? 'ok' : 'degraded',
      name: APP_NAME,
      version: APP_VERSION,
      environment: NODE_ENV,
      uptime: process.uptime(),
      startedAt: new Date(state.startedAt).toISOString(),
      timestamp: new Date().toISOString(),
      services: {
        api: 'ok',
        database: database ? 'connected' : 'disconnected',
        redis: cache ? 'connected' : 'disconnected',
        sockets: state.socketsReady ? 'ready' : 'not_ready',
        workers: state.workersReady ? 'ready' : 'not_ready',
        http: state.httpReady ? 'listening' : 'not_listening'
      },
      redis: redisStatus
    });
  })
);

app.get(
  '/api/health',
  asyncHandler(async (_req: Request, res: Response) => {
    let database = state.prismaReady;
    let cache = state.redisReady;
    let redisStatus: any = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }

    if (state.redisReady) {
      try {
        redisStatus = await redisHealthCheck();
        cache = true;
      } catch {
        redisStatus = null;
        cache = false;
      }
    }

    const healthy = database && cache && state.socketsReady && state.httpReady && !state.shuttingDown;

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      ok: healthy,
      status: healthy ? 'ok' : 'degraded',
      message: healthy ? 'Texa Backend Running' : 'Texa Backend Degraded',
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis: cache,
        sockets: state.socketsReady,
        workers: state.workersReady,
        http: state.httpReady
      },
      redis: redisStatus
    });
  })
);

app.get(
  '/ready',
  asyncHandler(async (_req: Request, res: Response) => {
    const ready =
      state.prismaReady &&
      state.redisReady &&
      state.socketsReady &&
      state.httpReady &&
      !state.shuttingDown;

    res.status(ready ? 200 : 503).json({
      success: ready,
      ok: ready,
      ready,
      services: {
        database: state.prismaReady,
        redis: state.redisReady,
        sockets: state.socketsReady,
        workers: state.workersReady,
        http: state.httpReady
      }
    });
  })
);

app.get(
  '/api/spec',
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json({
      openapi: '3.0.0',
      info: {
        title: APP_NAME,
        version: APP_VERSION,
        environment: NODE_ENV
      },
      servers: [
        {
          url: PUBLIC_API_URL,
          description: NODE_ENV
        }
      ],
      paths: {}
    });
  })
);

app.use('/api', routes);

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    ok: false,
    error: 'Route not found',
    code: 'ROUTE_NOT_FOUND',
    method: req.method,
    path: req.originalUrl,
    requestId: req.id
  });
});

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const requestIdValue = req.id || createRequestId();

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      })),
      requestId: requestIdValue
    });
  }

  const normalized = normalizeError(err);

  if (normalized.status >= 500) {
    console.error(
      JSON.stringify(
        {
          level: 'error',
          requestId: requestIdValue,
          method: req.method,
          path: req.originalUrl,
          ip: req.clientIp || getClientIp(req),
          status: normalized.status,
          code: normalized.code,
          message: err?.message,
          stack: err?.stack,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    );
  }

  res.status(normalized.status).json({
    success: false,
    ok: false,
    error: normalized.message,
    code: normalized.code,
    requestId: requestIdValue,
    ...(IS_PROD || !err?.stack ? {} : { stack: err.stack })
  });
});

const gracefulShutdown = async (signal: string) => {
  if (state.shuttingDown) return;

  state.shuttingDown = true;

  console.log(`[${signal}] graceful shutdown started`);

  const timeout = setTimeout(() => {
    console.error(`[${signal}] shutdown timeout exceeded`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    try {
      await closeWorkers();
    } catch (err) {
      console.error('workers shutdown failed', err);
    }

    await closeSocketServer();
    state.socketsReady = false;

    await closeHttpServer();
    state.httpReady = false;

    try {
      await prisma.$disconnect();
      state.prismaReady = false;
    } catch (err) {
      console.error('prisma disconnect failed', err);
    }

    try {
      await closeRedisConnections();
      state.redisReady = false;
    } catch (err) {
      console.error('redis disconnect failed', err);
    }

    clearTimeout(timeout);

    console.log(`[${signal}] graceful shutdown completed`);
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[${signal}] graceful shutdown failed`, err);
    process.exit(1);
  }
};

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', reason => {
  console.error('unhandledRejection', reason);
});

process.on('uncaughtException', error => {
  console.error('uncaughtException', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

const listen = () =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      state.httpReady = true;
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });

const bootstrap = async () => {
  try {
    await connectPrisma();
    await connectRedisClients();
    await initSockets();
    await startWorkers();
    await listen();

    console.log(`TEXA PRODUCTION SERVER RUNNING ON PORT ${PORT}`);
    console.log(`HTTP http://localhost:${PORT}`);
    console.log(`WS ws://localhost:${PORT}`);
    console.log(`ENV ${NODE_ENV}`);
    console.log('DATABASE connected');
    console.log('REDIS connected');
    console.log('SOCKETS ready');
    console.log('WORKERS ready');
  } catch (err) {
    console.error('bootstrap failed', err);

    try {
      await closeWorkers();
    } catch {}

    try {
      await prisma.$disconnect();
    } catch {}

    try {
      await closeRedisConnections();
    } catch {}

    process.exit(1);
  }
};

if (!IS_TEST) {
  bootstrap();
}

export { app, server, io, state, bootstrap };
export default app;
