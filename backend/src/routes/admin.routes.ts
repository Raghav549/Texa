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

  auth,
  adminOnly

} from '../middleware/auth';

import rateLimit from 'express-rate-limit';

// ============================================
// ROUTER
// ============================================

const router = Router();

// ============================================
// RATE LIMITERS
// ============================================

const adminLoginLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 5,

  standardHeaders: true,

  legacyHeaders: false,

  message: {

    success: false,

    error:
      'Too many admin login attempts. Try again later.',

  },

});

// ============================================
// ADMIN AUTH
// ============================================

router.post(

  '/login',

  adminLoginLimiter,

  adminLogin

);

// ============================================
// USERS
// ============================================

router.get(

  '/users',

  auth,

  adminOnly,

  listUsers

);

router.post(

  '/users/manage',

  auth,

  adminOnly,

  manageUser

);

router.post(

  '/users/verify',

  auth,

  adminOnly,

  toggleVerify

);

router.post(

  '/users/reset-password',

  auth,

  adminOnly,

  resetUserPass

);

router.post(

  '/users/manage-stats',

  auth,

  adminOnly,

  manageCoinsXP

);

// ============================================
// REPORTS
// ============================================

router.post(

  '/reports/manage',

  auth,

  adminOnly,

  manageReports

);

// ============================================
// CONTENT CONTROL
// ============================================

router.post(

  '/content/manage',

  auth,

  adminOnly,

  manageContent

);

// ============================================
// ANNOUNCEMENTS
// ============================================

router.post(

  '/announcements/create',

  auth,

  adminOnly,

  setAnnouncement

);

// ============================================
// ANALYTICS
// ============================================

router.get(

  '/analytics',

  auth,

  adminOnly,

  getAnalytics

);

export default router;
