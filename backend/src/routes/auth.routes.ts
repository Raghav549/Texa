import { Router } from 'express';
import { register, login, forgotPassword, resetPassword } from '../controllers/auth.controller';
import { upload } from '../middleware/upload';
const r = Router();
r.post('/register', upload.single('avatar'), register);
r.post('/login', login);
r.post('/forgot', forgotPassword);
r.post('/reset', resetPassword);
export default r;
