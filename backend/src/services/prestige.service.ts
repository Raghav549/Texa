import { prisma } from '../config/db';
export async function generatePrestigeData(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  return {
    fullName: user.fullName,
    username: user.username,
    bio: user.bio,
    followers: user.followers.length,
    following: user.following.length,
    dob: user.dob,
    id: user.id,
    xp: user.xp,
    level: user.level,
    isVerified: user.isVerified,
    avatar: user.avatarUrl
  };
}
