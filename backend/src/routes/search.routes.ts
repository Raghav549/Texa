import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  configureSearchIndexes,
  getPopularProducts,
  getPopularStores,
  getSearchIndexStats,
  getTrendingKeywords,
  getTrendingReels,
  healthCheckSearch,
  searchAutocomplete,
  searchGlobal,
  searchProducts,
  searchReels,
  searchStores,
  searchUsers
} from '../services/search';

const router = Router();

router.get('/health', async (_req, res, next) => {
  try {
    const result = await healthCheckSearch();
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/stats', authMiddleware, async (_req, res, next) => {
  try {
    const result = await getSearchIndexStats();
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.post('/configure', authMiddleware, async (_req, res, next) => {
  try {
    const result = await configureSearchIndexes();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/global', async (req, res, next) => {
  try {
    const result = await searchGlobal(String(req.query.q || ''), {
      limit: Number(req.query.limit || 10),
      offset: Number(req.query.offset || 0)
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/autocomplete', async (req, res, next) => {
  try {
    const result = await searchAutocomplete(String(req.query.q || ''), Number(req.query.limit || 6));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const result = await searchUsers(String(req.query.q || ''), {
      limit: Number(req.query.limit || 10),
      offset: Number(req.query.offset || 0)
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/reels', async (req, res, next) => {
  try {
    const result = await searchReels(String(req.query.q || ''), {
      limit: Number(req.query.limit || 10),
      offset: Number(req.query.offset || 0)
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/stores', async (req, res, next) => {
  try {
    const result = await searchStores(String(req.query.q || ''), {
      limit: Number(req.query.limit || 10),
      offset: Number(req.query.offset || 0)
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/products', async (req, res, next) => {
  try {
    const result = await searchProducts(String(req.query.q || ''), {
      limit: Number(req.query.limit || 10),
      offset: Number(req.query.offset || 0)
    });

    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/trending/keywords', async (req, res, next) => {
  try {
    const result = await getTrendingKeywords(Number(req.query.limit || 20));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/trending/reels', async (req, res, next) => {
  try {
    const result = await getTrendingReels(Number(req.query.limit || 20));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/popular/stores', async (req, res, next) => {
  try {
    const result = await getPopularStores(Number(req.query.limit || 20));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

router.get('/popular/products', async (req, res, next) => {
  try {
    const result = await getPopularProducts(Number(req.query.limit || 20));
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

export default router;
