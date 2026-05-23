import { Router } from 'express';
import { recommendationsController } from '../controllers/recommendations.controller';
import { recommendationsLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// POST /api/v1/recommendations
// Body: { feelings, bookIds, genres, dislikes }
// Returns: { recommendations: [{ bookId, rank, explanation }] }
router.post('/', recommendationsLimiter, recommendationsController.getRecommendations);

export default router;
