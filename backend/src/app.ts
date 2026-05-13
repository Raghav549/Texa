import express, { Application, NextFunction, Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createServer, Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { Server as SocketServer, Socket } from 'socket.io';
import { ZodError } from 'zod';
import { prisma } from './config/db';
import {
  redis,
  initRedisAdapter,
  connectRedis,
  closeRedisConnections
} from './config/redis';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import tradingRoutes from './routes/trading.routes';
import roomRoutes from './routes/room.routes';
import dmRoutes from './routes/dm.routes';
import adminRoutes from './routes/admin.routes';
import storyRoutes from './routes/story.routes';
import reelRoutes from './routes/reel.routes';
import storeRoutes from './routes/store.routes';
import productRoutes from './routes/product.routes';
import cartRoutes from './routes/cart.routes';
import orderRoutes from './routes/order.routes';
import { auth, adminOnly } from './middleware/auth';
import { initRoomSockets } from './sockets/room.socket';
import { initCommerceSockets } from './sockets/commerce.socket';
import { initTradingCron } from './controllers/trading.controller';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      startedAt?: number;
      clientIp?: string;
    }
  }
}

type JwtPayload = {
  userId: string;
  role?: string;
};

type ServerState = {
  startedAt: number;
  shuttingDown: boolean;
  prismaReady: boolean;
  redisReady: boolean;
  socketsReady: boolean;
  cronReady: boolean;
  httpReady: boolean;
};

const state: ServerState = {
  startedAt: Date.now(),
  shuttingDown: false,
  prismaReady: false,
  redisReady: false,
  socketsReady: false,
  cronReady: false,
  httpReady: false
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const APP_NAME = process.env.APP_NAME || 'Texa API';
const APP_VERSION = process.env.APP_VERSION || process.env.npm_package_version || '1.0.0';
const BODY_LIMIT = process.env.BODY_LIMIT || '25mb';
const URL_LIMIT = process.env.URL_LIMIT || '25mb';
const SOCKET_BUFFER_SIZE = Number(process.env.SOCKET_BUFFER_SIZE || 10 * 1024 * 1024);
const SOCKET_PING_TIMEOUT = Number(process.env.SOCKET_PING_TIMEOUT || 60000);
const SOCKET_PING_INTERVAL = Number(process.env.SOCKET_PING_INTERVAL || 25000);
const SOCKET_CONNECT_TIMEOUT = Number(process.env.SOCKET_CONNECT_TIMEOUT || 45000);
const SOCKET_RECOVERY_MS = Number(process.env.SOCKET_RECOVERY_MS || 120000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000);
const PUBLIC_API_URL = process.env.PUBLIC_API_URL || `http://localhost:${PORT}`;

const parseOrigins = (): CorsOptions['origin'] => {
  const raw = process.env.CORS_ORIGIN || process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || '';
  const list = raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (!list.length || list.includes('*')) return true;

  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (list.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
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
    'X-Platform'
  ],
  exposedHeaders: [
    'Content-Length',
    'Content-Type',
    'X-Request-Id',
    'X-Response-Time',
    'X-App-Version'
  ],
  maxAge: 86400
};

export const app: Application = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

export const server: HttpServer = createServer(app);

export const io = new SocketServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: SOCKET_PING_TIMEOUT,
  pingInterval: SOCKET_PING_INTERVAL,
  connectTimeout: SOCKET_CONNECT_TIMEOUT,
  maxHttpBufferSize: SOCKET_BUFFER_SIZE,
  allowEIO3: false,
  serveClient: false,
  connectionStateRecovery: {
    maxDisconnectionDuration: SOCKET_RECOVERY_MS,
    skipMiddlewares: true
  }
});

const createRequestId = () => `req_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

const getClientIp = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || req.ip;
  if (Array.isArray(forwarded)) return forwarded[0] || req.ip;
  return req.ip;
};

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const normalizeError = (err: any) => {
  const rawStatus =
    Number(err?.statusCode) ||
    Number(err?.status) ||
    Number(err?.response?.status) ||
    500;

  const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;

  const message =
    status >= 500 && isProduction
      ? 'Internal server error'
      : String(err?.message || 'Internal server error');

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
                : status === 429
                  ? 'RATE_LIMITED'
                  : 'SERVER_ERROR')
  ).toUpperCase();

  return { status, message, code };
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
  await redis.ping();
  state.redisReady = true;
};

const initSockets = async () => {
  if (state.socketsReady) return;
  await Promise.resolve(initRedisAdapter(io));
  await Promise.resolve(initRoomSockets(io));
  await Promise.resolve(initCommerceSockets(io));
  state.socketsReady = true;
};

const initCronJobs = async () => {
  if (state.cronReady) return;
  if (process.env.ENABLE_CRON !== 'false') {
    await Promise.resolve(initTradingCron());
  }
  state.cronReady = true;
};

const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_WINDOW_MS || 60 * 1000),
  max: Number(process.env.API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    ok: false,
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMITED'
  }
});

const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_RATE_LIMIT || 80),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    ok: false,
    error: 'Too many authentication attempts. Please try again later.',
    code: 'AUTH_RATE_LIMITED'
  }
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: isProduction
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

if (!isTest) {
  app.use(
    morgan(isProduction ? 'combined' : 'dev', {
      skip: req =>
        req.url === '/' ||
        req.url === '/health' ||
        req.url === '/ready' ||
        req.url === '/api/health'
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

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

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

    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }

    try {
      await redis.ping();
      cache = true;
    } catch {
      cache = false;
    }

    const healthy = database && cache && state.socketsReady && !state.shuttingDown;

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
        database: database ? 'ok' : 'error',
        redis: cache ? 'ok' : 'error',
        socket: state.socketsReady ? 'ok' : 'error',
        cron: state.cronReady ? 'ok' : 'pending',
        http: state.httpReady ? 'ok' : 'pending'
      }
    });
  })
);

app.get(
  '/api/health',
  asyncHandler(async (_req: Request, res: Response) => {
    let database = state.prismaReady;
    let cache = state.redisReady;

    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }

    try {
      await redis.ping();
      cache = true;
    } catch {
      cache = false;
    }

    const healthy = database && cache && state.socketsReady && !state.shuttingDown;

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      ok: healthy,
      message: healthy ? 'Texa Backend Running' : 'Texa Backend Degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        api: 'ok',
        database: database ? 'ok' : 'error',
        redis: cache ? 'ok' : 'error',
        socket: state.socketsReady ? 'ok' : 'error',
        cron: state.cronReady ? 'ok' : 'pending',
        http: state.httpReady ? 'ok' : 'pending'
      }
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
        cron: state.cronReady,
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

app.use('/api/auth', authRoutes);
app.use('/api/users', auth, userRoutes);
app.use('/api/user', auth, userRoutes);
app.use('/api/trade', auth, tradingRoutes);
app.use('/api/trading', auth, tradingRoutes);
app.use('/api/rooms', auth, roomRoutes);
app.use('/api/dm', auth, dmRoutes);
app.use('/api/messages', auth, dmRoutes);
app.use('/api/stories', auth, storyRoutes);
app.use('/api/reels', auth, reelRoutes);
app.use('/api/store', auth, storeRoutes);
app.use('/api/stores', auth, storeRoutes);
app.use('/api/product', auth, productRoutes);
app.use('/api/products', auth, productRoutes);
app.use('/api/cart', auth, cartRoutes);
app.use('/api/orders', auth, orderRoutes);
app.use('/api/order', auth, orderRoutes);
app.use('/api/admin', auth, adminOnly, adminRoutes);

io.use(async (socket: Socket, next) => {
  try {
    const rawToken =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization ||
      socket.handshake.query?.token;

    const token =
      typeof rawToken === 'string'
        ? rawToken.replace(/^Bearer\s+/i, '').trim()
        : Array.isArray(rawToken)
          ? rawToken[0]?.replace(/^Bearer\s+/i, '').trim()
          : '';

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return next(new Error('JWT secret missing'));
    }

    const decoded = jwt.verify(token, secret) as JwtPayload;

    if (!decoded?.userId) {
      return next(new Error('Invalid authentication token'));
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        role: true,
        isBanned: true
      }
    });

    if (!user) {
      return next(new Error('User not found'));
    }

    if (user.isBanned) {
      return next(new Error('User is banned'));
    }

    socket.data.userId = user.id;
    socket.data.role = decoded.role || user.role || 'USER';

    socket.join(`user:${user.id}`);
    socket.join('global');

    next();
  } catch {
    next(new Error('Authentication failed'));
  }
});

io.on('connection', socket => {
  const userId = String(socket.data.userId || '');
  const role = String(socket.data.role || 'USER');

  socket.emit('socket:connected', {
    socketId: socket.id,
    userId,
    role,
    timestamp: new Date().toISOString()
  });

  socket.on('user:online', async () => {
    if (!userId) return;

    try {
      await redis.set(`presence:${userId}`, JSON.stringify({ online: true, socketId: socket.id, at: new Date().toISOString() }), 'EX', 120);
    } catch {}

    io.to('global').emit('presence:online', {
      userId,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('user:heartbeat', async () => {
    if (!userId) return;

    try {
      await redis.set(`presence:${userId}`, JSON.stringify({ online: true, socketId: socket.id, at: new Date().toISOString() }), 'EX', 120);
    } catch {}

    socket.emit('user:heartbeat:ok', {
      userId,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('dm:join', ({ conversationId }) => {
    if (conversationId) socket.join(`dm:${conversationId}`);
  });

  socket.on('dm:leave', ({ conversationId }) => {
    if (conversationId) socket.leave(`dm:${conversationId}`);
  });

  socket.on('room:join', ({ roomId }) => {
    if (roomId) socket.join(`room:${roomId}`);
  });

  socket.on('room:leave', ({ roomId }) => {
    if (roomId) socket.leave(`room:${roomId}`);
  });

  socket.on('typing:start', ({ roomId, conversationId }) => {
    if (roomId) socket.to(`room:${roomId}`).emit('typing:start', { userId, roomId, timestamp: new Date().toISOString() });
    if (conversationId) socket.to(`dm:${conversationId}`).emit('typing:start', { userId, conversationId, timestamp: new Date().toISOString() });
  });

  socket.on('typing:stop', ({ roomId, conversationId }) => {
    if (roomId) socket.to(`room:${roomId}`).emit('typing:stop', { userId, roomId, timestamp: new Date().toISOString() });
    if (conversationId) socket.to(`dm:${conversationId}`).emit('typing:stop', { userId, conversationId, timestamp: new Date().toISOString() });
  });

  socket.on('reel:join', ({ reelId }) => {
    if (reelId) socket.join(`reel:${reelId}`);
  });

  socket.on('reel:leave', ({ reelId }) => {
    if (reelId) socket.leave(`reel:${reelId}`);
  });

  socket.on('story:join', ({ storyId }) => {
    if (storyId) socket.join(`story:${storyId}`);
  });

  socket.on('story:leave', ({ storyId }) => {
    if (storyId) socket.leave(`story:${storyId}`);
  });

  socket.on('trading:join', () => {
    socket.join('trading');
  });

  socket.on('trading:leave', () => {
    socket.leave('trading');
  });

  socket.on('store:join', ({ storeId }) => {
    if (storeId) socket.join(`store:${storeId}`);
  });

  socket.on('store:leave', ({ storeId }) => {
    if (storeId) socket.leave(`store:${storeId}`);
  });

  socket.on('product:join', ({ productId }) => {
    if (productId) socket.join(`product:${productId}`);
  });

  socket.on('product:leave', ({ productId }) => {
    if (productId) socket.leave(`product:${productId}`);
  });

  socket.on('cart:join', () => {
    if (userId) socket.join(`cart:${userId}`);
  });

  socket.on('cart:leave', () => {
    if (userId) socket.leave(`cart:${userId}`);
  });

  socket.on('order:join', ({ orderId }) => {
    if (orderId) socket.join(`order:${orderId}`);
  });

  socket.on('order:leave', ({ orderId }) => {
    if (orderId) socket.leave(`order:${orderId}`);
  });

  socket.on('admin:join', () => {
    if (['ADMIN', 'SUPERADMIN', 'admin', 'superadmin'].includes(role)) socket.join('admin');
  });

  socket.on('admin:leave', () => {
    socket.leave('admin');
  });

  socket.on('disconnect', async reason => {
    if (!userId) return;

    try {
      await redis.del(`presence:${userId}`);
    } catch {}

    io.to('global').emit('presence:offline', {
      userId,
      reason,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('error', error => {
    console.error('[Socket Error]', {
      socketId: socket.id,
      userId,
      message: error?.message || error,
      timestamp: new Date().toISOString()
    });
  });
});

io.engine.on('connection_error', err => {
  console.error('[Socket Connection Error]', {
    code: err.code,
    message: err.message,
    context: err.context,
    timestamp: new Date().toISOString()
  });
});

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
  const requestId = req.id || createRequestId();

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
      requestId
    });
  }

  const normalized = normalizeError(err);

  if (normalized.status >= 500) {
    console.error(
      JSON.stringify(
        {
          level: 'error',
          requestId,
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
    requestId,
    ...(isProduction || !err?.stack ? {} : { stack: err.stack })
  });
});

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

const gracefulShutdown = async (signal: string) => {
  if (state.shuttingDown) return;

  state.shuttingDown = true;

  console.log(`[${signal}] graceful shutdown started`);

  const timeout = setTimeout(() => {
    console.error(`[${signal}] shutdown timeout exceeded`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await closeSocketServer();
    state.socketsReady = false;

    await closeHttpServer();
    state.httpReady = false;

    try {
      await prisma.$disconnect();
      state.prismaReady = false;
    } catch (err) {
      console.error('[Prisma Disconnect Failed]', err);
    }

    try {
      await closeRedisConnections();
      state.redisReady = false;
    } catch (err) {
      console.error('[Redis Disconnect Failed]', err);
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
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', error => {
  console.error('[Uncaught Exception]', error);
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
    await initCronJobs();
    await listen();

    console.log(`TEXA PRODUCTION SERVER RUNNING ON PORT ${PORT}`);
    console.log(`HTTP http://localhost:${PORT}`);
    console.log(`WS ws://localhost:${PORT}`);
    console.log(`ENV ${NODE_ENV}`);
    console.log('DATABASE connected');
    console.log('REDIS connected');
    console.log('SOCKETS ready');
    console.log('CRON ready');
  } catch (err) {
    console.error('[Bootstrap Failed]', err);

    try {
      await prisma.$disconnect();
    } catch {}

    try {
      await closeRedisConnections();
    } catch {}

    process.exit(1);
  }
};

bootstrap();

export default app;
