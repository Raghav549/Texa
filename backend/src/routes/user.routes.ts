import { Router } from 'express';
import {
  getProfile,
  getMe,
  updateProfile,
  uploadAvatar,
  uploadCover,
  follow,
  unfollow,
  blockUser,
  unblockUser,
  searchUsers,
  getFollowers,
  getFollowing,
  getPrestige,
  getProfileStats
} from '../controllers/user.controller';
import { authMiddleware } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

router.get('/me', authMiddleware, getMe);
router.patch('/me', authMiddleware, updateProfile);
router.post('/me/avatar', authMiddleware, upload.single('avatar'), uploadAvatar);
router.post('/me/cover', authMiddleware, upload.single('cover'), uploadCover);
router.get('/search', authMiddleware, searchUsers);
router.get('/prestige', authMiddleware, getPrestige);
router.post('/follow/:targetId', authMiddleware, follow);
router.delete('/follow/:targetId', authMiddleware, unfollow);
router.post('/block/:targetId', authMiddleware, blockUser);
router.delete('/block/:targetId', authMiddleware, unblockUser);
router.get('/:id/stats', authMiddleware, getProfileStats);
router.get('/:id/followers', authMiddleware, getFollowers);
router.get('/:id/following', authMiddleware, getFollowing);
router.get('/:id', authMiddleware, getProfile);

export default router;
