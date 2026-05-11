import { prisma } from '../config/db';
import { io } from '../app';
import cron from 'node-cron';

export function initTradingCron() {
  // Reset & generate daily battles at 00:00
  cron.schedule('0 0 * * *', async () => {
    const today = await prisma.tradeDay.findUnique({ where: { date: new Date() } });
    if (!today) {
      await prisma.tradeDay.create({
         {
          date: new Date(),
          isActive: true,
          choices: [
            { id: 'c1', label: 'Coffee', votes: 0, invested: 0 },
            { id: 'c2', label: 'Tea', votes: 0, invested: 0 },
            { id: 'c3', label: 'Instagram', votes: 0, invested: 0 },
            { id: 'c4', label: 'YouTube', votes: 0, invested: 0 },
            { id: 'c5', label: 'Summer', votes: 0, invested: 0 },
            { id: 'c6', label: 'Winter', votes: 0, invested: 0 },
            { id: 'c7', label: 'Night Owl', votes: 0, invested: 0 },
            { id: 'c8', label: 'Morning Person', votes: 0, invested: 0 },
            { id: 'c9', label: 'Online Shopping', votes: 0, invested: 0 },
            { id: 'c10', label: 'Offline Shopping', votes: 0, invested: 0 }
          ]
        }
      });
    }
  });

  // Resolve daily battle at 23:55
  cron.schedule('55 23 * * *', async () => {
    const trade = await prisma.tradeDay.findFirst({ where: { isActive: true } });
    if (!trade) return;

    const choices = trade.choices as any[];
    const winner = choices.reduce((prev, curr) => (curr.votes + curr.invested) > (prev.votes + prev.invested) ? curr : prev);

    // Double coins for investors on winner
    const winners = await prisma.tradeVote.findMany({
      where: { tradeId: trade.id, choiceId: winner.id, isInvested: true }
    });

    for (const w of winners) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: w.userId },  { coins: { increment: w.amount } } }),
        prisma.tradeVote.update({ where: { id: w.id },  { isInvested: false, amount: 0 } })
      ]);
    }

    // Clear all losers
    await prisma.tradeVote.deleteMany({ where: { tradeId: trade.id, choiceId: { not: winner.id }, isInvested: true } });

    await prisma.tradeDay.update({ where: { id: trade.id },  { closedAt: new Date() } });
    io.emit('trading:reset', { date: new Date().toISOString() });
  });
}
