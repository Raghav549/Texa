import { Request, Response } from 'express';

import { prisma } from '../config/db';

import {
  addXP,
  checkAutoVerify
} from '../services/xp.service';

import {
  generatePrestigeData
} from '../services/prestige.service';

import {
  uploadFile
} from '../utils/upload';

export const getProfile = async (
  req: Request,
  res: Response
) => {
  try {

    const { id } = req.params;

    const user =
      await prisma.user.findUnique({
        where: { id }
      });

    if (!user) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    res.json({
      ...user,
      password: undefined
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to fetch profile'
    });
  }
};

export const follow = async (
  req: Request,
  res: Response
) => {
  try {

    const { targetId } =
      req.params;

    const followerId =
      req.userId!;

    if (followerId === targetId) {
      return res.status(400).json({
        error:
          'Cannot follow yourself'
      });
    }

    const targetUser =
      await prisma.user.findUnique({
        where: {
          id: targetId
        }
      });

    const currentUser =
      await prisma.user.findUnique({
        where: {
          id: followerId
        }
      });

    if (
      !targetUser ||
      !currentUser
    ) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const targetFollowers =
      targetUser.followers || [];

    const currentFollowing =
      currentUser.following || [];

    if (
      targetFollowers.includes(
        followerId
      )
    ) {
      return res.status(400).json({
        error:
          'Already following'
      });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: {
          id: targetId
        },

        data: {
          followers: {
            push: followerId
          }
        }
      }),

      prisma.user.update({
        where: {
          id: followerId
        },

        data: {
          following: {
            push: targetId
          }
        }
      })
    ]);

    await checkAutoVerify(
      targetId
    );

    res.json({
      status: 'ok'
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to follow user'
    });
  }
};

export const getPrestige = async (
  req: Request,
  res: Response
) => {
  try {

    const data =
      await generatePrestigeData(
        req.userId!
      );

    res.json(data);

  } catch (e: any) {

    console.error(e);

    res.status(400).json({
      error: e.message
    });
  }
};

export const createStory = async (
  req: Request,
  res: Response
) => {
  try {

    const { caption } =
      req.body;

    if (!req.file) {
      return res.status(400).json({
        error:
          'Media required'
      });
    }

    const url =
      await uploadFile(
        req.file,
        'stories'
      );

    await prisma.story.create({
      data: {
        userId: req.userId!,
        mediaUrl: url,
        caption
      }
    });

    await addXP(req.userId!, 3);

    res.status(201).json({
      status: 'uploaded'
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error:
        'Failed to create story'
    });
  }
};
