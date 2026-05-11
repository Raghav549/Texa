import { Request, Response } from 'express';

import { prisma } from '../config/db';

import { io } from '../app';

export const getActiveTrade = async (
  _req: Request,
  res: Response
) => {
  try {

    const trade =
      await prisma.tradeDay.findFirst({
        where: {
          isActive: true
        },

        orderBy: {
          date: 'desc'
        }
      });

    res.json(
      trade || {
        choices: [],
        isActive: false
      }
    );

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to fetch active trade'
    });
  }
};

export const adminSetChoices = async (
  req: Request,
  res: Response
) => {
  try {

    const { choices } = req.body;

    await prisma.tradeDay.updateMany({
      where: {
        isActive: true
      },

      data: {
        choices,
        isActive: false
      }
    });

    const newTrade =
      await prisma.tradeDay.create({
        data: {
          date: new Date(),
          choices,
          isActive: true
        }
      });

    io.emit(
      'trading:reset',
      {
        choices,
        tradeId: newTrade.id
      }
    );

    res.json({
      status: 'updated'
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to update trading choices'
    });
  }
};
