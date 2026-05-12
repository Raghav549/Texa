import express, { NextFunction, Request, Response } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { initRedisAdapter } from './config/redis';
import { prisma } from './config/db';
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

type JwtPayload = {
  userId: string;
  role?: string;
};

const allowedOrigins = (process.env.CORS_ORIGIN || process.env.CLIENT_URL || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Length', 'Content-Type']
};

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

export const server = createServer(app);

export const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 10 * 1024 * 1024,
  allowEIO3: true
});

initRedisAdapter(io);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: isProduction
      ? {
          useDefaults: true,
          directives: {
            'default-src': ["'self'"],
            'img-src': ["'self'", 'data:', 'https:'],
            'media-src': ["'self'", 'data:', 'https:'],
            'connect-src': ["'self'", ...allowedOrigins]
          }
        }
      : false
  })
);

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

if (!isProduction) {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.'
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT || 80),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again later.'
  }
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    name: 'Texa API',
    status: 'running',
    version: process.env.APP_VERSION || '1.0.0'
  });
});

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      success: true,
      message: 'Texa Backend Running',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        api: 'ok',
        database: 'ok',
        socket: 'ok'
      }
    });
  } catch {
    res.status(503).json({
      success: false,
      message: 'Texa Backend Degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        api: 'ok',
        database: 'error',
        socket: 'ok'
      }
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/users', auth, userRoutes);
app.use('/api/user', auth, userRoutes);
app.use('/api/trade', auth, tradingRoutes);
app.use('/api/trading', auth, tradingRoutes);
app.use('/api/rooms', auth, roomRoutes);
app.use('/api/dm', auth, dmRoutes);
app.use('/api/stories', auth, storyRoutes);
app.use('/api/reels', auth, reelRoutes);
app.use('/api/store', auth, storeRoutes);
app.use('/api/stores', auth, storeRoutes);
app.use('/api/product', auth, productRoutes);
app.use('/api/products', auth, productRoutes);
app.use('/api/cart', auth, cartRoutes);
app.use('/api/orders', auth, orderRoutes);
app.use('/api/admin', auth, adminOnly, adminRoutes);

io.use(async (socket: Socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers.authorization?.replace('Bearer ', '') ||
      socket.handshake.query?.token;

    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication token missing'));
    }

    if (!process.env.JWT_SECRET) {
      return next(new Error('JWT secret missing'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET) as JwtPayload;

    if (!decoded?.userId) {
      return next(new Error('Invalid authentication token'));
    }

    socket.data.userId = decoded.userId;
    socket.data.role = decoded.role || 'user';

    socket.join(`user:${decoded.userId}`);
    socket.join('global');

    next();
  } catch {
    next(new Error('Authentication failed'));
  }
});

io.on('connection', socket => {
  const userId = socket.data.userId;

  socket.emit('socket:connected', {
    socketId: socket.id,
    userId,
    timestamp: new Date().toISOString()
  });

  socket.on('user:online', async () => {
    io.to('global').emit('presence:online', { userId });
  });

  socket.on('typing:start', ({ roomId, conversationId }) => {
    if (roomId) socket.to(`room:${roomId}`).emit('typing:start', { userId, roomId });
    if (conversationId) socket.to(`dm:${conversationId}`).emit('typing:start', { userId, conversationId });
  });

  socket.on('typing:stop', ({ roomId, conversationId }) => {
    if (roomId) socket.to(`room:${roomId}`).emit('typing:stop', { userId, roomId });
    if (conversationId) socket.to(`dm:${conversationId}`).emit('typing:stop', { userId, conversationId });
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

  socket.on('cart:join', () => {
    socket.join(`cart:${userId}`);
  });

  socket.on('cart:leave', () => {
    socket.leave(`cart:${userId}`);
  });

  socket.on('disconnect', reason => {
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
      message: error?.message || error
    });
  });
});

initRoomSockets(io);
initCommerceSockets(io);

if (process.env.ENABLE_CRON !== 'false') {
  initTradingCron();
}

io.engine.on('connection_error', err => {
  console.error('[Socket Connection Error]', {
    code: err.code,
    message: err.message,
    context: err.context
  });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]', err);

  res.status(500).json({
    success: false,
    error: isProduction ? 'Internal server error' : err.message
  });
});

process.on('unhandledRejection', reason => {
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', error => {
  console.error('[Uncaught Exception]', error);
});

export default app;
