import { prisma } from '../config/db';
import { io } from '../app';
import cron from 'node-cron';

export function initTradingCron() {
  cron.schedule('0 0 * * *', async () => {
    const choices = Array.from({ length: 10 }, (_, i) => ({ id: `c${i+1}`, label: ['Coffee','Tea','IG','YT','Summer','Winter','Night','Morning','Online','Offline'][i], votes: 0, invested: 0 }));
    await prisma.tradeDay.create({ data: { date: new Date(), choices, isActive: true } });
  });

  cron.schedule('55 23 * * *', async () => {
    const trade = await prisma.tradeDay.findFirst({ where: { isActive: true } });
    if (!trade) return;
    const choices = trade.choices as any[];
    const winner = choices.reduce((prev, curr) => (curr.votes + curr.invested) > (prev.votes + prev.invested) ? curr : prev);
    await prisma.$transaction([
      ...await prisma.tradeVote.findMany({ where: { tradeId: trade.id, choiceId: winner.id, isInvested: true } }).map(v => prisma.user.update({ where: { id: v.userId },  { coins: { increment: v.amount } } })),
      prisma.tradeVote.deleteMany({ where: { tradeId: trade.id } }),
      prisma.tradeDay.update({ where: { id: trade.id },  { isActive: false, closedAt: new Date() } })
    ]);
    io.emit('trading:reset', { date: new Date().toISOString() });
  });
}
