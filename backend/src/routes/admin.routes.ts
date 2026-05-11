import { Router } from 'express';

import {
  adminLogin,
  listUsers,
  manageUser,
  toggleVerify,
  resetUserPass,
  manageCoinsXP,
  manageReports,
  manageContent,
  setAnnouncement,
  getAnalytics
} from '../controllers/admin.controller';

import {
  adminOnly
} from '../middleware/auth';

const router = Router();

// =====================================
// AUTH
// =====================================

router.post(
  '/login',
  adminLogin
);

// =====================================
// USERS
// =====================================

router.get(
  '/users',
  adminOnly,
  listUsers
);

router.post(
  '/users/manage',
  adminOnly,
  manageUser
);

router.post(
  '/users/verify',
  adminOnly,
  toggleVerify
);

router.post(
  '/users/reset',
  adminOnly,
  resetUserPass
);

router.post(
  '/users/stats',
  adminOnly,
  manageCoinsXP
);

// =====================================
// REPORTS
// =====================================

router.post(
  '/reports/handle',
  adminOnly,
  manageReports
);

// =====================================
// CONTENT CONTROL
// =====================================

router.post(
  '/content/delete',
  adminOnly,
  manageContent
);

// =====================================
// ANNOUNCEMENTS
// =====================================

router.post(
  '/announcement',
  adminOnly,
  setAnnouncement
);

// =====================================
// ANALYTICS
// =====================================

router.get(
  '/analytics',
  adminOnly,
  getAnalytics
);

export default router;
