import { Request, Response } from 'express';

import { prisma } from '../config/db';

import { uploadFile } from '../utils/upload';

import { addXP } from '../services/xp.service';

export const createReel = async (
  req: Request,
  res: Response
) => {
  try {

    if (!req.file) {
      return res.status(400).json({
        error: 'Video required'
      });
    }

    const url = await uploadFile(
      req.file,
      'reels'
    );

    const {
      caption,
      filterData,
      musicTrack
    } = req.body;

    const reel =
      await prisma.reel.create({
        data: {
          userId: req.userId!,
          videoUrl: url,
          caption,

          filterData: JSON.parse(
            filterData || '{}'
          ),

          musicTrack
        }
      });

    await addXP(req.userId!, 8);

    res.status(201).json(reel);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to create reel'
    });
  }
};

export const getReels = async (
  req: Request,
  res: Response
) => {
  try {

    const reels =
      await prisma.reel.findMany({
        take: 20,

        orderBy: {
          createdAt: 'desc'
        },

        include: {
          author: {
            select: {
              username: true,
              avatarUrl: true,
              isVerified: true
            }
          }
        }
      });

    res.json(reels);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to fetch reels'
    });
  }
};

export const likeReel = async (
  req: Request,
  res: Response
) => {
  try {

    const { id } = req.params;

    const reel =
      await prisma.reel.findUnique({
        where: { id }
      });

    if (!reel) {
      return res.status(404).json({
        error: 'Reel not found'
      });
    }

    const likes = reel.likes || [];

    const hasLiked =
      likes.includes(req.userId!);

    const updatedLikes = hasLiked
      ? likes.filter(
          (l) => l !== req.userId!
        )
      : [...likes, req.userId!];

    await prisma.reel.update({
      where: { id },

      data: {
        likes: updatedLikes
      }
    });

    res.json({
      liked: !hasLiked
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to like reel'
    });
  }
};

export const commentReel = async (
  req: Request,
  res: Response
) => {
  try {

    const { text } = req.body;

    await prisma.comment.create({
      data: {
        reelId: req.params.id,
        userId: req.userId!,
        text
      }
    });

    res.json({
      status: 'posted'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'Failed to comment'
    });
  }
};
