import { prisma } from '../../config/db';
import { io } from '../../app';

export type GiftProcessResult = {
  success: true;
  giftId: string;
  fromId: string;
  toId: string;
  amountCharged: number;
  creatorEarning: number;
  platformFee: number;
  transactionId?: string;
};

export type GiftLeaderboardItem = {
  creatorId: string;
  rank: number;
  totalEarnings: number;
  giftsReceived: number;
};

const CREATOR_SHARE = Number(process.env.CREATOR_GIFT_SHARE || 0.7);
const PLATFORM_SHARE = 1 - CREATOR_SHARE;
const MIN_GIFT_AMOUNT = 1;

const safeCoins = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const getRoomId = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentRoomId: true }
  });

  return user?.currentRoomId || null;
};

const emitSafe = (room: string, event: string, payload: unknown) => {
  try {
    io.to(room).emit(event, payload);
  } catch {}
};

export async function processGift(
  giftId: string,
  fromId: string,
  toId: string,
  amount: number
): Promise<GiftProcessResult> {
  if (!giftId || !fromId || !toId) throw new Error('Missing gift sender or receiver');
  if (fromId === toId) throw new Error('Cannot send gift to yourself');

  const sentAmount = safeCoins(amount);
  if (sentAmount < MIN_GIFT_AMOUNT) throw new Error('Invalid gift amount');

  const result = await prisma.$transaction(async tx => {
    const [gift, sender, receiver] = await Promise.all([
      tx.gift.findUnique({ where: { id: giftId } }),
      tx.user.findUnique({
        where: { id: fromId },
        select: { id: true, username: true, avatarUrl: true, coins: true, isVerified: true }
      }),
      tx.user.findUnique({
        where: { id: toId },
        select: { id: true, username: true, avatarUrl: true, currentRoomId: true, isVerified: true }
      })
    ]);

    if (!gift) throw new Error('Gift not found');
    if (!sender) throw new Error('Sender not found');
    if (!receiver) throw new Error('Receiver not found');

    const giftPrice = safeCoins(gift.price);
    if (giftPrice <= 0) throw new Error('Invalid gift price');
    if (sentAmount < giftPrice) throw new Error('Insufficient gift amount');
    if (sender.coins < giftPrice) throw new Error('Insufficient coins');

    const creatorEarning = safeCoins(giftPrice * CREATOR_SHARE);
    const platformFee = giftPrice - creatorEarning;

    const updatedSender = await tx.user.update({
      where: { id: fromId },
      data: { coins: { decrement: giftPrice } },
      select: { coins: true }
    });

    const updatedReceiver = await tx.user.update({
      where: { id: toId },
      data: { coins: { increment: creatorEarning } },
      select: { coins: true }
    });

    const economy = await tx.creatorEconomy.upsert({
      where: { creatorId: toId },
      update: {
        totalEarnings: { increment: creatorEarning },
        giftsReceived: { increment: 1 },
        platformFeesGenerated: { increment: platformFee },
        lastGiftAt: new Date()
      },
      create: {
        creatorId: toId,
        totalEarnings: creatorEarning,
        giftsReceived: 1,
        platformFeesGenerated: platformFee,
        lastGiftAt: new Date()
      }
    });

    let transactionId: string | undefined;

    if ('giftTransaction' in tx) {
      const transaction = await (tx as any).giftTransaction.create({
        data: {
          giftId,
          fromId,
          toId,
          amount: giftPrice,
          creatorEarning,
          platformFee,
          status: 'completed',
          metadata: {
            senderBalanceAfter: updatedSender.coins,
            receiverBalanceAfter: updatedReceiver.coins,
            creatorEconomyId: economy.id
          }
        }
      });

      transactionId = transaction.id;
    }

    if ('coinLedger' in tx) {
      await (tx as any).coinLedger.createMany({
        data: [
          {
            userId: fromId,
            type: 'gift_sent',
            amount: -giftPrice,
            balanceAfter: updatedSender.coins,
            referenceId: transactionId || giftId,
            metadata: { giftId, toId }
          },
          {
            userId: toId,
            type: 'gift_received',
            amount: creatorEarning,
            balanceAfter: updatedReceiver.coins,
            referenceId: transactionId || giftId,
            metadata: { giftId, fromId, platformFee }
          }
        ]
      });
    }

    return {
      gift,
      sender,
      receiver,
      giftPrice,
      creatorEarning,
      platformFee,
      transactionId
    };
  });

  const roomId = result.receiver.currentRoomId || await getRoomId(toId);

  const payload = {
    giftId,
    transactionId: result.transactionId,
    fromId,
    toId,
    gift: result.gift,
    amount: result.giftPrice,
    creatorEarning: result.creatorEarning,
    platformFee: result.platformFee,
    sender: {
      id: result.sender.id,
      username: result.sender.username,
      avatarUrl: result.sender.avatarUrl,
      isVerified: result.sender.isVerified
    },
    receiver: {
      id: result.receiver.id,
      username: result.receiver.username,
      avatarUrl: result.receiver.avatarUrl,
      isVerified: result.receiver.isVerified
    },
    createdAt: new Date().toISOString()
  };

  if (roomId) emitSafe(`room:${roomId}`, 'gift:trigger', payload);
  emitSafe(`user:${toId}`, 'gift:received', payload);
  emitSafe(`user:${fromId}`, 'gift:sent', payload);
  emitSafe('creator:economy', 'gift:processed', {
    toId,
    giftId,
    amount: result.giftPrice,
    creatorEarning: result.creatorEarning,
    platformFee: result.platformFee
  });

  return {
    success: true,
    giftId,
    fromId,
    toId,
    amountCharged: result.giftPrice,
    creatorEarning: result.creatorEarning,
    platformFee: result.platformFee,
    transactionId: result.transactionId
  };
}

export async function updateCreatorRanking(): Promise<GiftLeaderboardItem[]> {
  const creators = await prisma.creatorEconomy.findMany({
    orderBy: [
      { totalEarnings: 'desc' },
      { giftsReceived: 'desc' },
      { updatedAt: 'asc' }
    ],
    select: {
      id: true,
      creatorId: true,
      totalEarnings: true,
      giftsReceived: true
    }
  });

  if (!creators.length) return [];

  const updates = creators.map((creator, index) =>
    prisma.creatorEconomy.update({
      where: { id: creator.id },
      data: { rank: index + 1 }
    })
  );

  await prisma.$transaction(updates);

  const leaderboard = creators.map((creator, index) => ({
    creatorId: creator.creatorId,
    rank: index + 1,
    totalEarnings: creator.totalEarnings,
    giftsReceived: creator.giftsReceived
  }));

  emitSafe('creator:economy', 'creator:ranking_updated', {
    updatedAt: new Date().toISOString(),
    leaderboard: leaderboard.slice(0, 50)
  });

  return leaderboard;
}

export async function getCreatorGiftStats(creatorId: string) {
  const economy = await prisma.creatorEconomy.findUnique({
    where: { creatorId },
    include: {
      creator: {
        select: {
          id: true,
          username: true,
          avatarUrl: true,
          isVerified: true
        }
      }
    }
  });

  if (!economy) {
    return {
      creatorId,
      totalEarnings: 0,
      giftsReceived: 0,
      platformFeesGenerated: 0,
      rank: null,
      lastGiftAt: null
    };
  }

  return economy;
}

export async function getCreatorGiftLeaderboard(limit = 50): Promise<GiftLeaderboardItem[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

  const creators = await prisma.creatorEconomy.findMany({
    orderBy: [
      { rank: 'asc' },
      { totalEarnings: 'desc' }
    ],
    take: safeLimit,
    select: {
      creatorId: true,
      rank: true,
      totalEarnings: true,
      giftsReceived: true
    }
  });

  return creators.map(creator => ({
    creatorId: creator.creatorId,
    rank: creator.rank,
    totalEarnings: creator.totalEarnings,
    giftsReceived: creator.giftsReceived
  }));
}

export async function refundGiftTransaction(transactionId: string, adminId?: string) {
  if (!transactionId) throw new Error('Transaction ID required');

  return prisma.$transaction(async tx => {
    if (!('giftTransaction' in tx)) throw new Error('Gift transaction model not available');

    const transaction = await (tx as any).giftTransaction.findUnique({
      where: { id: transactionId }
    });

    if (!transaction) throw new Error('Gift transaction not found');
    if (transaction.status === 'refunded') throw new Error('Gift already refunded');
    if (transaction.status !== 'completed') throw new Error('Only completed gifts can be refunded');

    const [sender, receiver] = await Promise.all([
      tx.user.update({
        where: { id: transaction.fromId },
        data: { coins: { increment: transaction.amount } },
        select: { coins: true }
      }),
      tx.user.update({
        where: { id: transaction.toId },
        data: { coins: { decrement: transaction.creatorEarning } },
        select: { coins: true }
      })
    ]);

    await tx.creatorEconomy.update({
      where: { creatorId: transaction.toId },
      data: {
        totalEarnings: { decrement: transaction.creatorEarning },
        giftsReceived: { decrement: 1 },
        platformFeesGenerated: { decrement: transaction.platformFee }
      }
    });

    await (tx as any).giftTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        refundedBy: adminId || null
      }
    });

    if ('coinLedger' in tx) {
      await (tx as any).coinLedger.createMany({
        data: [
          {
            userId: transaction.fromId,
            type: 'gift_refund_received',
            amount: transaction.amount,
            balanceAfter: sender.coins,
            referenceId: transactionId,
            metadata: { giftId: transaction.giftId, adminId }
          },
          {
            userId: transaction.toId,
            type: 'gift_refund_reversed',
            amount: -transaction.creatorEarning,
            balanceAfter: receiver.coins,
            referenceId: transactionId,
            metadata: { giftId: transaction.giftId, adminId }
          }
        ]
      });
    }

    emitSafe(`user:${transaction.fromId}`, 'gift:refunded', {
      transactionId,
      amount: transaction.amount
    });

    emitSafe(`user:${transaction.toId}`, 'gift:earning_reversed', {
      transactionId,
      amount: transaction.creatorEarning
    });

    return {
      success: true,
      transactionId,
      refundedAmount: transaction.amount,
      reversedCreatorEarning: transaction.creatorEarning
    };
  });
}
