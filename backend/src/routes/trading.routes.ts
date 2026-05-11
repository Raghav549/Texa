import { Router } from 'express';
import { getActiveTrade, adminSetChoices } from '../controllers/trading.controller';
import { auth, adminOnly } from '../middleware/auth';
const r = Router();
r.use(auth);
r.get('/active', getActiveTrade);
r.post('/admin/choices', adminOnly, adminSetChoices);
export default r;
