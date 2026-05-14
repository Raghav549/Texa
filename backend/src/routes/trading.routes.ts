import { Router } from 'express';
import {
  getActiveTrading,
  voteTrade,
  investTrade,
  switchTradeInvestment,
  getTradingHistory,
  getTradingLeaderboard,
  getTradingStats,
  resolveTradingManually,
  joinTradingRoom
} from '../controllers/trading.controller';
import {
  adminOnly
} from '../middleware/auth';

const router = Router();

const requireAuth = (req: any, res: any, next: any) => {
  if (!req.userId) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  next();
};

router.get(
  '/active',
  requireAuth,
  getActiveTrading
);

router.post(
  '/vote',
  requireAuth,
  voteTrade
);

router.post(
  '/invest',
  requireAuth,
  investTrade
);

router.post(
  '/switch',
  requireAuth,
  switchTradeInvestment
);

router.get(
  '/history',
  requireAuth,
  getTradingHistory
);

router.get(
  '/leaderboard',
  requireAuth,
  getTradingLeaderboard
);

router.get(
  '/stats',
  requireAuth,
  getTradingStats
);

router.get(
  '/join',
  requireAuth,
  joinTradingRoom
);

router.post(
  '/admin/resolve/:dayId',
  adminOnly,
  resolveTradingManually
);

export default router;
