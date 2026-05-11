import { prisma } from '../config/db';

export async function updateCoins(userId: string, delta: number) {
  return await prisma.user.update({
    where: { id: userId },
     { coins: { increment: delta } }
  });
}
