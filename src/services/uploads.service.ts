import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { groups } from '../db/schema';
import { config } from '../config';
import { signUploadParams } from '../lib/cloudinary-signature';
import { uploadAssetFolder, uploadFolder, type UploadKind } from '../lib/cloudinary-url';

/** Formats Cloudinary will accept on a signed upload; anything else is rejected there. */
export const ALLOWED_UPLOAD_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] as const;

/** Cloudinary honours an upload signature for one hour from its timestamp; we can't shorten that. */
const SIGNATURE_TTL_SECONDS = 60 * 60;

export interface UploadSignature {
  /** POST the image here as multipart/form-data. */
  uploadUrl: string;
  /** Send every one of these as form fields, unchanged, alongside `file`. */
  params: Record<string, string | number | boolean>;
  expiresAt: string;
}

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code && { code }) });
}

export const uploadsService = {
  /**
   * Signs one direct-to-Cloudinary image upload for `userId`.
   *
   * - 'user'   → the caller's profile photo, at a fixed public ID so a new
   *              photo replaces the old one instead of piling up.
   * - 'group'  → a group's photo, fixed public ID likewise. Owner only — the
   *              same rule as editing the group.
   * - 'upload' → a one-off image in the caller's own folder, under a fresh
   *              random ID. Also what a client uses for a group photo before
   *              the group exists.
   */
  async createSignature(userId: number, kind: UploadKind, groupId?: number): Promise<UploadSignature> {
    const { cloudName, apiKey, apiSecret } = config.cloudinary;
    if (!apiKey || !apiSecret) {
      throw httpError('Image uploads are not configured', 503, 'CLOUDINARY_NOT_CONFIGURED');
    }

    let publicId: string;
    let replaces = false;
    if (kind === 'group') {
      if (groupId === undefined) throw httpError('groupId is required for a group upload', 400);
      const [owned] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.id, groupId), eq(groups.ownerId, userId)))
        .limit(1);
      // 404 rather than 403, as PATCH /groups/:id does: a non-owner learns
      // nothing about whether the group exists.
      if (!owned) throw httpError('Group not found', 404);
      publicId = `${uploadFolder('group', groupId)}/photo`;
      replaces = true;
    } else if (kind === 'user') {
      publicId = `${uploadFolder('user', userId)}/avatar`;
      replaces = true;
    } else {
      publicId = `${uploadFolder('upload', userId)}/${randomUUID()}`;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signed: Record<string, string | number | boolean> = {
      public_id: publicId,
      // Files the image under kinkane/users etc. in the Media Library. On a
      // dynamic-folder account the public ID alone doesn't create folders there.
      asset_folder: uploadAssetFolder(kind),
      timestamp,
      allowed_formats: ALLOWED_UPLOAD_FORMATS.join(','),
      // A replacement gets a new version number, so its URL changes and the
      // client stores that; invalidating just stops the CDN serving the old
      // image to anyone still holding the previous URL.
      overwrite: replaces,
      ...(replaces && { invalidate: true }),
    };

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      params: { ...signed, api_key: apiKey, signature: signUploadParams(signed, apiSecret) },
      expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
    };
  },
};
