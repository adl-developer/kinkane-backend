import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { uploadSignatureLimiter } from '../middleware/rate-limit.middleware';
import { uploadsController } from '../controllers/uploads.controller';
import { wrapHttp } from '../lib/route-helpers';

const router = Router();

/**
 * POST /api/v1/uploads/signature
 *
 * Signs one image upload that the client then sends straight to Cloudinary —
 * the image never passes through this server. POST the file as multipart to
 * `uploadUrl` with every field in `params` unchanged; then send the
 * `secure_url` from Cloudinary's response to the endpoint that stores it
 * (PATCH /user/settings/profile, POST /groups, PATCH /groups/:groupId).
 *
 * Body: { kind: 'user' } | { kind: 'upload' } | { kind: 'group', groupId: number }
 * Returns 200: { uploadUrl, params: { public_id, asset_folder, timestamp, allowed_formats, overwrite,
 *               invalidate?, api_key, signature }, expiresAt }
 * Errors: 400 invalid body | 401 | 404 group not found or not owned |
 *         429 | 503 CLOUDINARY_NOT_CONFIGURED
 */
router.post('/signature', requireAuth, uploadSignatureLimiter, wrapHttp(uploadsController.createSignature));

export default router;
