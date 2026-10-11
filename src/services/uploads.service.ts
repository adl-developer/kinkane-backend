import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { groups } from '../db/schema';
import { config } from '../config';
import { signUploadParams } from '../lib/cloudinary-signature';
import { uploadAssetFolder, uploadFolder, type UploadKind } from '../lib/cloudinary-url';

/**
 * Formats stored as uploaded. Anything else (notably HEIC/HEIF straight from the
 * iOS picker) is converted to CONVERT_TO on upload rather than rejected: a stored
 * .heic URL renders as a broken image in most browsers and many Android versions.
 */
export const ALLOWED_UPLOAD_FORMATS = ['jpg', 'jpeg', 'png', 'webp'] as const;
const CONVERT_TO = 'jpg';

/** Cloudinary honours an upload signature for one hour from its timestamp; we can't shorten that. */
const SIGNATURE_TTL_SECONDS = 60 * 60;

/** What to sign for. A group upload names the group, which the caller must own. */
export type UploadTarget = { kind: 'user' } | { kind: 'upload' } | { kind: 'group'; groupId: number };

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
   * Every upload gets a fresh random public ID inside the folder for its kind:
   * `users/<userId>` for a profile photo, `groups/<groupId>` for a group photo
   * (owner only, the same rule as editing the group), `uploads/<userId>` for
   * anything else, including a group photo picked before the group exists.
   *
   * Random rather than a fixed `…/avatar` overwritten each time, for two reasons.
   * An overwrite changes the photo everyone sees the moment the upload lands,
   * even if the client never saves the new URL. And a fixed ID is guessable, so
   * anyone could fetch any user's or group's photo by counting through IDs.
   */
  async createSignature(userId: number, target: UploadTarget): Promise<UploadSignature> {
    const { cloudName, apiKey, apiSecret } = config.cloudinary;
    if (!apiKey || !apiSecret) {
      throw httpError('Image uploads are not configured', 503, 'CLOUDINARY_NOT_CONFIGURED');
    }

    let folder: string;
    if (target.kind === 'group') {
      const [owned] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(eq(groups.id, target.groupId), eq(groups.ownerId, userId)))
        .limit(1);
      // 404 rather than 403, as PATCH /groups/:id does: a non-owner learns
      // nothing about whether the group exists.
      if (!owned) throw httpError('Group not found', 404);
      folder = uploadFolder('group', target.groupId);
    } else {
      folder = uploadFolder(target.kind, userId);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signed: Record<string, string | number | boolean> = {
      public_id: `${folder}/${randomUUID()}`,
      // Files the image under kinkane/users etc. in the Media Library. On a
      // dynamic-folder account the public ID alone doesn't create folders there.
      asset_folder: uploadAssetFolder(target.kind),
      timestamp,
      allowed_formats: ALLOWED_UPLOAD_FORMATS.join(','),
      format: CONVERT_TO,
    };

    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      params: { ...signed, api_key: apiKey, signature: signUploadParams(signed, apiSecret) },
      expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
    };
  },
};
