import { Router } from 'express';
import {
  createRoom,
  getRooms,
  getRoom,
  joinRoom,
  leaveRoom,
  roomControl,
  updateRoom,
  requestToSpeak,
  getMyActiveRoom,
  getRoomParticipants
} from '../controllers/voice.controller';
import { authMiddleware } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

router.get('/', authMiddleware, getRooms);

router.get('/me/active', authMiddleware, getMyActiveRoom);

router.post('/', authMiddleware, upload.single('cover'), createRoom);

router.get('/:id', authMiddleware, getRoom);

router.patch('/:id', authMiddleware, upload.single('cover'), updateRoom);

router.post('/:id/join', authMiddleware, joinRoom);

router.post('/:id/leave', authMiddleware, leaveRoom);

router.post('/:id/control', authMiddleware, roomControl);

router.post('/:id/request-speak', authMiddleware, requestToSpeak);

router.get('/:id/participants', authMiddleware, getRoomParticipants);

export default router;
