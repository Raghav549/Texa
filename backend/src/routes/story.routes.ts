import { Router } from 'express';

import {
  createStory,
  getStories,
  viewStory,
  reactStory
} from '../controllers/story.controller';

import {
  upload
} from '../middleware/upload';

const router = Router();

// =====================================
// CREATE STORY
// =====================================

router.post(
  '/',
  upload.single('media'),
  createStory
);

// =====================================
// GET STORIES
// =====================================

router.get(
  '/',
  getStories
);

// =====================================
// VIEW STORY
// =====================================

router.post(
  '/:id/view',
  viewStory
);

// =====================================
// REACT STORY
// =====================================

router.post(
  '/:id/react',
  reactStory
);

export default router;
