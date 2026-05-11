import { Router } from 'express';

import {
  createRoom,
  getActiveRooms,
  hostControl
} from '../controllers/voice.controller';

import {
  upload
} from '../middleware/upload';

const router = Router();

// =====================================
// CREATE ROOM
// =====================================

router.post(
  '/',
  upload.single('cover'),
  createRoom
);

// =====================================
// GET ACTIVE ROOMS
// =====================================

router.get(
  '/',
  getActiveRooms
);

// =====================================
// HOST CONTROLS
// =====================================

router.post(
  '/:id/control',
  hostControl
);

export default router;
