import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { getFollowingFeed, getPersonalizedFeed, getTrendingFeed, trackInteraction } from '../services/feed';

const router = Router();

router.get('/personalized', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const feed = await getPersonalizedFeed(userId, {
      limit: Number(req.query.limit || 20),
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      category: req.query.category ? String(req.query.category) : null,
      excludeSeen: req.query.excludeSeen === 'true',
      freshnessHours: req.query.freshnessHours ? Number(req.query.freshnessHours) : undefined
    });

    res.json({ success: true, feed });
  } catch (error) {
    next(error);
  }
});

router.get('/following', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const feed = await getFollowingFeed(
      userId,
      Number(req.query.limit || 20),
      req.query.cursor ? String(req.query.cursor) : null
    );

    res.json({ success: true, feed });
  } catch (error) {
    next(error);
  }
});

router.get('/trending', authMiddleware, async (req, res, next) => {
  try {
    const feed = await getTrendingFeed(
      Number(req.query.limit || 20),
      req.query.cursor ? String(req.query.cursor) : null
    );

    res.json({ success: true, feed });
  } catch (error) {
    next(error);
  }
});

router.post('/interaction', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await trackInteraction(
      userId,
      req.body.reelId,
      req.body.type,
      Number(req.body.duration || 1),
      req.body.metadata || {}
    );

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
