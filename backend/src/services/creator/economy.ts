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
  rank: number | null;
  totalEarnings: number;
  giftsReceived: number;
};

type GiftTxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const RAW_CREATOR_SHARE = Number(process.env.CREATOR_GIFT_SHARE || 0.7);
const CREATOR_SHARE = Number.isFinite(RAW_CREATOR_SHARE) ? Math.min(1, Math.max(0, RAW_CREATOR_SHARE)) : 0.7;
const PLATFORM_SHARE = 1 - CREATOR_SHARE;
const MIN_GIFT_AMOUNT = Number(process.env.MIN_GIFT_AMOUNT || 1);
const MAX_GIFT_AMOUNT = Number(process.env.MAX_GIFT_AMOUNT || 1000000);

const safeCoins = (value: any) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.floor(amount));
};

const safeLimit = (value: any, fallback = 50) => {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(limit)));
};

const hasModel = (client: any, model: string) => Boolean(client && client[model]);

const emitSafe = (room: string, event: string, payload: unknown) => {
  try {
    io.to(room).emit(event, payload);
  } catch {}
};

const emitGlobalSafe = (event: string, payload: unknown) => {
  try {
    io.emit(event, payload);
  } catch {}
};

const getRoomId = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { currentRoomId: true }
  });

  return user?.currentRoomId || null;
};

const createCoinTransactionIfAvailable = async (
  tx: GiftTxClient,
  data: {
    userId: string;
    amount: number;
    balance: number;
    type: string;
    source?: string;
    status?: string;
    referenceId?: string | null;
    metadata?: Record<string, any>;
  }
) => {
  const client = tx as any;

  if (hasModel(client, 'coinTransaction')) {
    const payload: Record<string, any> = {
      userId: data.userId,
      amount: data.amount,
      balance: data.balance,
      type: data.type,
      status: data.status || 'COMPLETED'
    };

    if (data.source) payload.source = data.source;
    if (data.referenceId) payload.referenceId = data.referenceId;
    if (data.metadata) payload.metadata = data.metadata;

    try {
      return await client.coinTransaction.create({ data: payload });
    } catch {
      try {
        return await client.coinTransaction.create({
          data: {
            userId: data.userId,
            amount: data.amount,
            balance: data.balance,
            type: data.type,
            source: data.source || 'ADMIN',
            status: data.status || 'COMPLETED'
          }
        });
      } catch {
        return null;
      }
    }
  }

  if (hasModel(client, 'coinLedger')) {
    const payload: Record<string, any> = {
      userId: data.userId,
      type: data.type,
      amount: data.amount,
      balanceAfter: data.balance
    };

    if (data.referenceId) payload.referenceId = data.referenceId;
    if (data.metadata) payload.metadata = data.metadata;

    try {
      return await client.coinLedger.create({ data: payload });
    } catch {
      return null;
    }
  }

  return null;
};

const createGiftTransactionIfAvailable = async (
  tx: GiftTxClient,
  data: {
    giftId: string;
    fromId: string;
    toId: string;
    amount: number;
    creatorEarning: number;
    platformFee: number;
    metadata?: Record<string, any>;
  }
) => {
  const client = tx as any;

  if (!hasModel(client, 'giftTransaction')) return null;

  try {
    return await client.giftTransaction.create({
      data: {
        giftId: data.giftId,
        fromId: data.fromId,
        toId: data.toId,
        amount: data.amount,
        creatorEarning: data.creatorEarning,
        platformFee: data.platformFee,
        status: 'completed',
        metadata: data.metadata || {}
      }
    });
  } catch {
    try {
      return await client.giftTransaction.create({
        data: {
          giftId: data.giftId,
          fromId: data.fromId,
          toId: data.toId,
          amount: data.amount,
          creatorEarning: data.creatorEarning,
          platformFee: data.platformFee,
          status: 'COMPLETED'
        }
      });
    } catch {
      return null;
    }
  }
};

const updateCreatorEconomySafe = async (
  tx: GiftTxClient,
  creatorId: string,
  creatorEarning: number,
  platformFee: number
) => {
  return tx.creatorEconomy.upsert({
    where: { creatorId },
    update: {
      totalEarnings: { increment: creatorEarning },
      giftsReceived: { increment: 1 },
      platformFeesGenerated: { increment: platformFee },
      lastGiftAt: new Date()
    },
    create: {
      creatorId,
      totalEarnings: creatorEarning,
      giftsReceived: 1,
      platformFeesGenerated: platformFee,
      lastGiftAt: new Date()
    }
  });
};

const decrementCreatorEconomySafe = async (
  tx: GiftTxClient,
  creatorId: string,
  creatorEarning: number,
  platformFee: number
) => {
  const economy = await tx.creatorEconomy.findUnique({
    where: { creatorId },
    select: {
      totalEarnings: true,
      giftsReceived: true,
      platformFeesGenerated: true
    }
  });

  if (!economy) return null;

  return tx.creatorEconomy.update({
    where: { creatorId },
    data: {
      totalEarnings: Math.max(0, safeCoins(economy.totalEarnings) - safeCoins(creatorEarning)),
      giftsReceived: Math.max(0, safeCoins(economy.giftsReceived) - 1),
      platformFeesGenerated: Math.max(0, safeCoins(economy.platformFeesGenerated) - safeCoins(platformFee))
    }
  });
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
  if (sentAmount > MAX_GIFT_AMOUNT) throw new Error('Gift amount exceeds limit');

  const result = await prisma.$transaction(async tx => {
    const [gift, sender, receiver] = await Promise.all([
      tx.gift.findUnique({
        where: { id: giftId }
      }),
      tx.user.findUnique({
        where: { id: fromId },
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          coins: true,
          isVerified: true
        }
      }),
      tx.user.findUnique({
        where: { id: toId },
        select: {
          id: true,
          username: true,
          fullName: true,
          avatarUrl: true,
          coins: true,
          currentRoomId: true,
          isVerified: true
        }
      })
    ]);

    if (!gift) throw new Error('Gift not found');
    if (!sender) throw new Error('Sender not found');
    if (!receiver) throw new Error('Receiver not found');

    const giftPrice = safeCoins((gift as any).price || sentAmount);
    if (giftPrice <= 0) throw new Error('Invalid gift price');
    if (sentAmount < giftPrice) throw new Error('Insufficient gift amount');
    if (safeCoins(sender.coins) < giftPrice) throw new Error('Insufficient coins');

    const creatorEarning = safeCoins(giftPrice * CREATOR_SHARE);
    const platformFee = safeCoins(giftPrice - creatorEarning);

    const updatedSender = await tx.user.update({
      where: { id: fromId },
      data: {
        coins: {
          decrement: giftPrice
        }
      },
      select: {
        coins: true
      }
    });

    const updatedReceiver = await tx.user.update({
      where: { id: toId },
      data: {
        coins: {
          increment: creatorEarning
        }
      },
      select: {
        coins: true
      }
    });

    const economy = await updateCreatorEconomySafe(tx, toId, creatorEarning, platformFee);

    const transaction = await createGiftTransactionIfAvailable(tx, {
      giftId,
      fromId,
      toId,
      amount: giftPrice,
      creatorEarning,
      platformFee,
      metadata: {
        senderBalanceAfter: updatedSender.coins,
        receiverBalanceAfter: updatedReceiver.coins,
        creatorEconomyId: economy.id,
        creatorShare: CREATOR_SHARE,
        platformShare: PLATFORM_SHARE
      }
    });

    const referenceId = transaction?.id || giftId;

    await Promise.all([
      createCoinTransactionIfAvailable(tx, {
        userId: fromId,
        amount: -giftPrice,
        balance: safeCoins(updatedSender.coins),
        type: 'GIFT_SENT',
        source: 'GIFT',
        status: 'COMPLETED',
        referenceId,
        metadata: {
          giftId,
          toId,
          creatorEarning,
          platformFee
        }
      }),
      createCoinTransactionIfAvailable(tx, {
        userId: toId,
        amount: creatorEarning,
        balance: safeCoins(updatedReceiver.coins),
        type: 'GIFT_RECEIVED',
        source: 'GIFT',
        status: 'COMPLETED',
        referenceId,
        metadata: {
          giftId,
          fromId,
          platformFee
        }
      })
    ]);

    return {
      gift,
      sender,
      receiver,
      giftPrice,
      creatorEarning,
      platformFee,
      transactionId: transaction?.id as string | undefined
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
      fullName: result.sender.fullName,
      avatarUrl: result.sender.avatarUrl,
      isVerified: result.sender.isVerified
    },
    receiver: {
      id: result.receiver.id,
      username: result.receiver.username,
      fullName: result.receiver.fullName,
      avatarUrl: result.receiver.avatarUrl,
      isVerified: result.receiver.isVerified
    },
    createdAt: new Date().toISOString()
  };

  if (roomId) {
    emitSafe(`room:${roomId}`, 'gift:trigger', payload);
    emitSafe(roomId, 'gift:trigger', payload);
  }

  emitSafe(`user:${toId}`, 'gift:received', payload);
  emitSafe(`user:${fromId}`, 'gift:sent', payload);
  emitSafe('creator:economy', 'gift:processed', {
    toId,
    giftId,
    amount: result.giftPrice,
    creatorEarning: result.creatorEarning,
    platformFee: result.platformFee
  });
  emitGlobalSafe('gift:processed', {
    giftId,
    fromId,
    toId,
    amount: result.giftPrice
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

  await prisma.$transaction(
    creators.map((creator, index) =>
      prisma.creatorEconomy.update({
        where: { id: creator.id },
        data: { rank: index + 1 }
      })
    )
  );

  const leaderboard = creators.map((creator, index) => ({
    creatorId: creator.creatorId,
    rank: index + 1,
    totalEarnings: safeCoins(creator.totalEarnings),
    giftsReceived: safeCoins(creator.giftsReceived)
  }));

  emitSafe('creator:economy', 'creator:ranking_updated', {
    updatedAt: new Date().toISOString(),
    leaderboard: leaderboard.slice(0, 50)
  });

  return leaderboard;
}

export async function getCreatorGiftStats(creatorId: string) {
  if (!creatorId) throw new Error('Creator ID required');

  const economy = await prisma.creatorEconomy.findUnique({
    where: { creatorId },
    include: {
      creator: {
        select: {
          id: true,
          username: true,
          fullName: true,
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
      lastGiftAt: null,
      creator: null
    };
  }

  return economy;
}

export async function getCreatorGiftLeaderboard(limit = 50): Promise<GiftLeaderboardItem[]> {
  const take = safeLimit(limit);

  const creators = await prisma.creatorEconomy.findMany({
    orderBy: [
      { rank: 'asc' },
      { totalEarnings: 'desc' },
      { giftsReceived: 'desc' }
    ],
    take,
    select: {
      creatorId: true,
      rank: true,
      totalEarnings: true,
      giftsReceived: true
    }
  });

  return creators.map((creator, index) => ({
    creatorId: creator.creatorId,
    rank: creator.rank || index + 1,
    totalEarnings: safeCoins(creator.totalEarnings),
    giftsReceived: safeCoins(creator.giftsReceived)
  }));
}

export async function refundGiftTransaction(transactionId: string, adminId?: string) {
  if (!transactionId) throw new Error('Transaction ID required');

  const result = await prisma.$transaction(async tx => {
    const client = tx as any;

    if (!hasModel(client, 'giftTransaction')) throw new Error('Gift transaction model not available');

    const transaction = await client.giftTransaction.findUnique({
      where: { id: transactionId }
    });

    if (!transaction) throw new Error('Gift transaction not found');

    const status = String(transaction.status || '').toLowerCase();

    if (status === 'refunded') throw new Error('Gift already refunded');
    if (status !== 'completed') throw new Error('Only completed gifts can be refunded');

    const senderUser = await tx.user.findUnique({
      where: { id: transaction.fromId },
      select: { coins: true }
    });

    const receiverUser = await tx.user.findUnique({
      where: { id: transaction.toId },
      select: { coins: true }
    });

    if (!senderUser) throw new Error('Sender not found');
    if (!receiverUser) throw new Error('Receiver not found');
    if (safeCoins(receiverUser.coins) < safeCoins(transaction.creatorEarning)) throw new Error('Receiver has insufficient coins to reverse');

    const [sender, receiver] = await Promise.all([
      tx.user.update({
        where: { id: transaction.fromId },
        data: {
          coins: {
            increment: safeCoins(transaction.amount)
          }
        },
        select: {
          coins: true
        }
      }),
      tx.user.update({
        where: { id: transaction.toId },
        data: {
          coins: {
            decrement: safeCoins(transaction.creatorEarning)
          }
        },
        select: {
          coins: true
        }
      })
    ]);

    await decrementCreatorEconomySafe(tx, transaction.toId, transaction.creatorEarning, transaction.platformFee);

    await client.giftTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'refunded',
        refundedAt: new Date(),
        refundedBy: adminId || null
      }
    }).catch(async () => {
      await client.giftTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'REFUNDED'
        }
      });
    });

    await Promise.all([
      createCoinTransactionIfAvailable(tx, {
        userId: transaction.fromId,
        amount: safeCoins(transaction.amount),
        balance: safeCoins(sender.coins),
        type: 'GIFT_REFUND_RECEIVED',
        source: 'GIFT',
        status: 'COMPLETED',
        referenceId: transactionId,
        metadata: {
          giftId: transaction.giftId,
          adminId: adminId || null
        }
      }),
      createCoinTransactionIfAvailable(tx, {
        userId: transaction.toId,
        amount: -safeCoins(transaction.creatorEarning),
        balance: safeCoins(receiver.coins),
        type: 'GIFT_REFUND_REVERSED',
        source: 'GIFT',
        status: 'COMPLETED',
        referenceId: transactionId,
        metadata: {
          giftId: transaction.giftId,
          adminId: adminId || null
        }
      })
    ]);

    return {
      success: true,
      transactionId,
      fromId: transaction.fromId,
      toId: transaction.toId,
      refundedAmount: safeCoins(transaction.amount),
      reversedCreatorEarning: safeCoins(transaction.creatorEarning)
    };
  });

  emitSafe(`user:${result.fromId}`, 'gift:refunded', {
    transactionId,
    amount: result.refundedAmount
  });

  emitSafe(`user:${result.toId}`, 'gift:earning_reversed', {
    transactionId,
    amount: result.reversedCreatorEarning
  });

  emitSafe('creator:economy', 'gift:refunded', {
    transactionId,
    fromId: result.fromId,
    toId: result.toId,
    amount: result.refundedAmount,
    reversedCreatorEarning: result.reversedCreatorEarning
  });

  return {
    success: true,
    transactionId: result.transactionId,
    refundedAmount: result.refundedAmount,
    reversedCreatorEarning: result.reversedCreatorEarning
  };
}
