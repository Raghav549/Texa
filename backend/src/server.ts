import dotenv from 'dotenv';

dotenv.config();

import { server } from './app';

import { prisma } from './config/prisma';

import { connectRedis, redis } from './config/redis';

// ============================================
// PORT
// ============================================

const PORT = process.env.PORT || 3000;

// ============================================
// START SERVER
// ============================================

async function startServer() {

  try {

    // Prisma
    await prisma.$connect();

    console.log('PostgreSQL Connected');

    // Redis
    await connectRedis();

    // Server
    server.listen(PORT, () => {

      console.log(`🟢 Texa Backend running on port ${PORT}`);

    });

  } catch (error) {

    console.error('Server startup failed:', error);

    process.exit(1);

  }

}

startServer();

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGINT', async () => {

  console.log('Shutting down server...');

  await prisma.$disconnect();

  if (redis.isOpen) {

    await redis.disconnect();

  }

  process.exit(0);

});

// ============================================
// UNHANDLED ERRORS
// ============================================

process.on('unhandledRejection', (reason) => {

  console.error('Unhandled Rejection:', reason);

});

process.on('uncaughtException', (error) => {

  console.error('Uncaught Exception:', error);

});
