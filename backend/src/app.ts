import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { prisma } from './config/db';
import { redis } from './config/redis';
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import tradingRoutes from './routes/trading.routes';
import roomRoutes from './routes/room.routes';
import dmRoutes from './routes/dm.routes';
import adminRoutes from './routes/admin.routes';
import { initTradingEngine } from './services/trading.service';
import { initRoomSockets } from './sockets/room.socket';
import { auth } from './middleware/auth';

export const app = express();
export const server = createServer(app);
export const io = new Server(server, { cors: { origin: '*' }, transports: ['websocket'] });

app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', auth, userRoutes);
app.use('/api/trade', auth, tradingRoutes);
app.use('/api/rooms', auth, roomRoutes);
app.use('/api/dm', auth, dmRoutes);
app.use('/api/admin', adminOnly, adminRoutes);

// WebSockets
initTradingEngine();
initRoomSockets(io);

// Attach user to socket
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { userId: string };
    socket.data.userId = decoded.userId;
    next();
  } catch { next(new Error('Auth required')); }
});

export { redis, prisma };
