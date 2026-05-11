import { Router } from 'express';

import {

  sendMessage,
  getConversation,
  markSeen

} from '../controllers/dm.controller';

import { auth } from '../middleware/auth';

import { upload } from '../middleware/upload';

import rateLimit from 'express-rate-limit';

// ============================================
// ROUTER
// ============================================

const router = Router();

// ============================================
// GLOBAL AUTH
// ============================================

router.use(auth);

// ============================================
// RATE LIMITERS
// ============================================

const messageLimiter = rateLimit({

  windowMs: 60 * 1000,

  max: 40,

  standardHeaders: true,

  legacyHeaders: false,

  message: {

    success: false,

    error:
      'Too many messages sent. Please slow down.',

  },

});

const seenLimiter = rateLimit({

  windowMs: 60 * 1000,

  max: 100,

  standardHeaders: true,

  legacyHeaders: false,

  message: {

    success: false,

    error:
      'Too many requests. Please slow down.',

  },

});

// ============================================
// SEND MESSAGE
// ============================================

router.post(

  '/send',

  messageLimiter,

  upload.single('media'),

  sendMessage

);

// ============================================
// GET CONVERSATION
// ============================================

router.get(

  '/conversation/:userId',

  getConversation

);

// ============================================
// MARK AS SEEN
// ============================================

router.post(

  '/seen',

  seenLimiter,

  markSeen

);

export default router;
