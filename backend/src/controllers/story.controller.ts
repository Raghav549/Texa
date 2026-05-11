import { Request, Response } from 'express';

import { prisma } from '../config/db';

import { uploadFile } from '../utils/upload';

import { addXP } from '../services/xp.service';

export const createStory = async (
  req: Request,
  res: Response
) => {
  try {

    if (!req.file) {
      return res.status(400).json({
        error: 'Media required'
      });
    }

    const url = await uploadFile(
      req.file,
      'stories'
    );

    const {
      caption,
      musicTrack,
      stickers
    } = req.body;

    const story =
      await prisma.story.create({
        data: {
          userId: req.userId!,
          mediaUrl: url,
          caption,
          musicTrack,

          stickers: JSON.parse(
            stickers || '{}'
          )
        }
      });

    await addXP(req.userId!, 5);

    res.status(201).json(story);

  } catch (e: any) {

    console.error(e);

    res.status(500).json({
      error: e.message
    });
  }
};

export const getStories = async (
  req: Request,
  res: Response
) => {
  try {

    const stories =
      await prisma.story.findMany({
        where: {
          expiresAt: {
            gt: new Date()
          },

          NOT: {
            userId: req.userId!
          }
        },

        include: {
          author: {
            select: {
              username: true,
              isVerified: true,
              avatarUrl: true
            }
          }
        }
      });

    res.json(stories);

  } catch (e: any) {

    console.error(e);

    res.status(500).json({
      error:
        'Failed to fetch stories'
    });
  }
};

export const viewStory = async (
  req: Request,
  res: Response
) => {
  try {

    await prisma.story.update({
      where: {
        id: req.params.id
      },

      data: {
        viewers: {
          push: req.userId!
        }
      }
    });

    res.json({
      status: 'viewed'
    });

  } catch (e: any) {

    console.error(e);

    res.status(500).json({
      error:
        'Failed to view story'
    });
  }
};

export const reactStory = async (
  req: Request,
  res: Response
) => {
  try {

    const { emoji } = req.body;

    const story =
      await prisma.story.findUnique({
        where: {
          id: req.params.id
        }
      });

    if (!story) {
      return res.status(404).json({
        error: 'Story not found'
      });
    }

    const reactions: any =
      story.reactions || {};

    reactions[emoji] =
      (reactions[emoji] || 0) + 1;

    await prisma.story.update({
      where: {
        id: req.params.id
      },

      data: {
        reactions
      }
    });

    res.json({
      status: 'reacted'
    });

  } catch (e: any) {

    console.error(e);

    res.status(500).json({
      error:
        'Failed to react to story'
    });
  }
};
