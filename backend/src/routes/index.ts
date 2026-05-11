import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import storyRoutes from './story.routes';
import reelRoutes from './reel.routes';
import tradingRoutes from './trading.routes';
import voiceRoutes from './voice.routes';
import dmRoutes from './dm.routes';
import adminRoutes from './admin.routes';
import { auth } from '../middleware/auth';

const router = Router();
router.use('/auth', authRoutes);
router.use('/user', auth, userRoutes);
router.use('/story', auth, storyRoutes);
router.use('/reel', auth, reelRoutes);
router.use('/trade', auth, tradingRoutes);
router.use('/voice', auth, voiceRoutes);
router.use('/dm', auth, dmRoutes);
router.use('/admin', adminRoutes);

export default router;
