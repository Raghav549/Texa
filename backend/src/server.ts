import { server, app, io } from './app';
import { redis } from './app';
import { prisma } from './app';

const PORT = process.env.PORT || 3000;

async function start() {
  await redis.connect();
  await prisma.$connect();
  server.listen(PORT, () => console.log(`🟢 Texa Backend live on :${PORT} | Realtime Active`));
}

start().catch(e => { console.error(e); process.exit(1); });
