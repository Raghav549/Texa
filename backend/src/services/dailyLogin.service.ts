import { prisma } from '../config/db';
import { io } from '../app';
import { addXP } from './xp.service';
import { updateCoins } from './coin.service';

export async function handleDailyLogin(userId: string) {
const today = new Date().toDateString();
const lastLogin = await prisma.user.findUnique({ where: { id: userId }, select: { lastLogin: true, loginStreak: true } });
const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
const isNewDay = lastLogin?.lastLogin?.toDateString() !== today;
const isStreak = lastLogin?.lastLogin?.toDateString() === yesterday.toDateString();

if (isNewDay) {
const newStreak = isStreak ? (lastLogin!.loginStreak || 0) + 1 : 1;
const coins = Math.min(newStreak * 10, 100);
await prisma.user.update({ where: { id: userId }, data: { lastLogin: new Date(), loginStreak: newStreak } });
await Promise.all([addXP(userId, newStreak), updateCoins(userId, coins)]);
io.to(userId).emit('daily:reward', { streak: newStreak, coins, xp: newStreak });
}
}
