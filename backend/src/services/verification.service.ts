import { prisma } from '../config/db';

export async function checkAutoVerify(
  userId: string
) {

  try {

    const user =
      await prisma.user.findUnique({
        where: {
          id: userId
        }
      });

    if (
      user &&
      user.followers.length >= 1000 &&
      !user.isVerified &&
      user.username !== 'kashyap'
    ) {

      return await prisma.user.update({
        where: {
          id: userId
        },

        data: {
          isVerified: true
        }
      });
    }

    return null;

  } catch (error) {

    console.error(
      'Auto verify error:',
      error
    );

    return null;
  }
}

export const KASHYAP_CHECK = {
  username: 'kashyap',

  fullName: 'Texa'
};
