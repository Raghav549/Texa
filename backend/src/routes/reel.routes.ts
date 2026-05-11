import { Router } from 'express';

import {
  createReel,
  getReels,
  likeReel,
  commentReel
} from '../controllers/reel.controller';

import {
  upload
} from '../middleware/upload';

const router = Router();

// =====================================
// CREATE REEL
// =====================================

router.post(
  '/',
  upload.single('video'),
  createReel
);

// =====================================
// REEL FEED
// =====================================

router.get(
  '/feed',
  getReels
);

// =====================================
// LIKE REEL
// =====================================

router.post(
  '/:id/like',
  likeReel
);

// =====================================
// COMMENT REEL
// =====================================

router.post(
  '/:id/comment',
  commentReel
);

export default router;
