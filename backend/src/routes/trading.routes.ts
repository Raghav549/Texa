import { Router } from 'express';

import {
  getActiveTrade,
  adminSetChoices
} from '../controllers/trading.controller';

import {
  adminOnly
} from '../middleware/auth';

const router = Router();

// =====================================
// ACTIVE TRADE
// =====================================

router.get(
  '/active',
  getActiveTrade
);

// =====================================
// ADMIN CHOICES
// =====================================

router.post(
  '/admin/choices',
  adminOnly,
  adminSetChoices
);

export default router;
