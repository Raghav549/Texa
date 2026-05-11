import { Router } from 'express';

import {

  register,
  login,
  forgotPassword,
  resetPassword,
  verifyEmail

} from '../controllers/auth.controller';

import { upload } from '../middleware/upload';

import rateLimit from 'express-rate-limit';

// ============================================
// ROUTER
// ============================================

const router = Router();

// ============================================
// RATE LIMITERS
// ============================================

const authLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 10,

  standardHeaders: true,

  legacyHeaders: false,

  message: {

    success: false,

    error:
      'Too many requests. Please try again later.',

  },

});

const forgotLimiter = rateLimit({

  windowMs: 15 * 60 * 1000,

  max: 5,

  standardHeaders: true,

  legacyHeaders: false,

  message: {

    success: false,

    error:
      'Too many password reset attempts. Please try later.',

  },

});

// ============================================
// AUTH ROUTES
// ============================================

// Register
router.post(

  '/register',

  authLimiter,

  upload.single('avatar'),

  register

);

// Login
router.post(

  '/login',

  authLimiter,

  login

);

// Verify Email
router.get(

  '/verify-email',

  verifyEmail

);

// Forgot Password
router.post(

  '/forgot-password',

  forgotLimiter,

  forgotPassword

);

// Reset Password
router.post(

  '/reset-password',

  forgotLimiter,

  resetPassword

);

export default router;
