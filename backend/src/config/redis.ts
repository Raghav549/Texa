import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {

  throw new Error('REDIS_URL is missing in environment variables');

}

export const redis = createClient({

  url: redisUrl,

  socket: {

    reconnectStrategy(retries) {

      if (retries > 10) {

        console.error('Redis reconnect failed too many times');

        return new Error('Redis reconnect failed');

      }

      return Math.min(retries * 100, 3000);

    },

  },

});

// ============================================
// REDIS EVENTS
// ============================================

redis.on('connect', () => {

  console.log('Redis Connecting...');

});

redis.on('ready', () => {

  console.log('Redis Connected');

});

redis.on('error', (err: Error) => {

  console.error('Redis Error:', err.message);

});

redis.on('end', () => {

  console.log('Redis Connection Closed');

});

// ============================================
// CONNECT REDIS
// ============================================

export const connectRedis = async () => {

  try {

    await redis.connect();

    console.log('Redis connection established');

  } catch (error) {

    console.error('Failed to connect Redis:', error);

    process.exit(1);

  }

};
