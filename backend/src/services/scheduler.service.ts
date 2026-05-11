import cron from 'node-cron';
import { prisma } from '../config/db';
import { io } from '../app';
import { addXP } from './xp.service';
import { updateCoins } from './coin.service';

export function initSchedulers() {
  // 1. Auto-Verify Check (Every 5 mins)
  cron.schedule('*/5 * * * *', async () => {
    const candidates = await prisma.user.findMany({
      where: { isVerified: false, followers: { isEmpty: false }, NOT: { username: 'kashyap' } }
    });
    for (const user of candidates) {
      if (user.followers.length >= 1000) {
        await prisma.user.update({ where: { id: user.id },  { isVerified: true } });
        io.to(user.id).emit('verify:success', { userId: user.id });
      }
    }
  });

  // 2. Story Expiry Cleanup (Every hour)
  cron.schedule('0 * * * *', async () => {
    await prisma.story.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  });

  // 3. Daily Trading Resolution (23:55)
  cron.schedule('55 23 * * *', async () => {
    const trade = await prisma.tradeDay.findFirst({ where: { isActive: true } });
    if (!trade) return;
    const choices = trade.choices as any[];
    const winner = choices.reduce((a, b) => (a.votes + a.invested) > (b.votes + b.invested) ? a : b);
    const winners = await prisma.tradeVote.findMany({ where: { tradeId: trade.id, choiceId: winner.id, isInvested: true } });
    await prisma.$transaction([
      ...winners.map(w => prisma.user.update({ where: { id: w.userId },  { coins: { increment: w.amount } } })),
      prisma.tradeVote.deleteMany({ where: { tradeId: trade.id } }),
      prisma.tradeDay.update({ where: { id: trade.id },  { isActive: false, closedAt: new Date() } })
    ]);
    io.emit('trading:reset');
  });

  // 4. Daily Login Streak & Rewards (00:00 check on login, handled in auth controller)
}
