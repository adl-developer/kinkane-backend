import { Router } from 'express';
import { gardnersDropshipController } from '../controllers/gardners-dropship.controller';

const router = Router();

router.post('/orders', gardnersDropshipController.create);
router.get('/orders/:id', gardnersDropshipController.get);
router.post('/orders/:id/poll-ack', gardnersDropshipController.pollAck);

export default router;
