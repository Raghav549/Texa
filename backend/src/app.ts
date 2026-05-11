import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';

import { createServer } from 'http';
import { Server } from 'socket.io';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import tradingRoutes from './routes/trading.routes';
import roomRoutes from './routes/room.routes';
import dmRoutes from './routes/dm.routes';
import adminRoutes from './routes/admin.routes';

import { initRoomSockets } from './sockets/room.socket';

import { auth, adminOnly } from './middleware/auth';

// ============================================
// EXPRESS APP
// ============================================

export const app = express();

app.set('trust proxy', 1);

// ============================================
// HTTP SERVER
// ============================================

export const server = createServer(app);

// ============================================
// SOCKET SERVER
// ============================================

export const io = new Server(server, {

  cors: {

    origin: process.env.CLIENT_URL,

    methods: ['GET', 'POST'],

    credentials: true,

  },

  transports: ['websocket', 'polling'],

});

// ============================================
// MIDDLEWARES
// ============================================

app.use(helmet());

app.use(cors({

  origin: process.env.CLIENT_URL,

  credentials: true,

}));

app.use(express.json({

  limit: '10mb',

}));

app.use(express.urlencoded({

  extended: true,

  limit: '10mb',

}));

// ============================================
// HEALTH ROUTE
// ============================================

app.get('/api/health', (_, res) => {

  res.status(200).json({

    success: true,

    message: 'Texa Backend Running',

  });

});

// ============================================
// API ROUTES
// ============================================

app.use('/api/auth', authRoutes);

app.use('/api/users', auth, userRoutes);

app.use('/api/trade', auth, tradingRoutes);

app.use('/api/rooms', auth, roomRoutes);

app.use('/api/dm', auth, dmRoutes);

app.use('/api/admin', auth, adminOnly, adminRoutes);

// ============================================
// SOCKET AUTH
// ============================================

io.use(async (socket, next) => {

  try {

    const token = socket.handshake.auth?.token;

    if (!token) {

      return next(new Error('Authentication token missing'));

    }

    const decoded = jwt.verify(

      token,

      process.env.JWT_SECRET as string

    ) as { userId: string };

    socket.data.userId = decoded.userId;

    next();

  } catch (error) {

    next(new Error('Authentication failed'));

  }

});

// ============================================
// SOCKET INITIALIZATION
// ============================================

initRoomSockets(io);

// ============================================
// SOCKET ERROR LOGGING
// ============================================

io.engine.on('connection_error', (err) => {

  console.error('Socket Connection Error:', err);

});
