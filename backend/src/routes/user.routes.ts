import { Router } from 'express';

import {
  getProfile,
  searchUsers,
  follow,
  getPrestige
} from '../controllers/user.controller';

const router = Router();

// =====================================
// SEARCH USERS
// =====================================

router.get(
  '/search',
  searchUsers
);

// =====================================
// PRESTIGE CARD
// =====================================

router.get(
  '/prestige',
  getPrestige
);

// =====================================
// FOLLOW USER
// =====================================

router.post(
  '/follow/:targetId',
  follow
);

// =====================================
// USER PROFILE
// KEEP LAST (dynamic route)
// =====================================

router.get(
  '/:id',
  getProfile
);

export default router;
