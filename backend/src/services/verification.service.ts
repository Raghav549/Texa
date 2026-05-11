import { prisma } from '../config/db';
export async function checkAutoVerify(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user && user.followers.length >= 1000 && !user.isVerified && user.username !== 'kashyap') {
    return prisma.user.update({ where: { id: userId },  { isVerified: true } });
  }
  return null;
}

export const KASHYAP_CHECK = { username: 'kashyap', fullName: 'Texa' };
