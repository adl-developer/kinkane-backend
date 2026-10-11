import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Signed direct-to-Cloudinary uploads: the signature itself, the folder each
 * kind of upload is pinned to, and the check that a stored photo URL came from
 * a folder the caller was signed for.
 */

const { dbResult } = vi.hoisted(() => ({ dbResult: { rows: [] as { id: number }[] } }));

// Just enough of drizzle's builder for the one ownership lookup.
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => dbResult.rows }) }) }),
  },
}));

import { config } from '../config';
import { signUploadParams } from '../lib/cloudinary-signature';
import { isCloudinaryUrlInFolders, unsignedPhotoUrlError, uploadFolder } from '../lib/cloudinary-url';
import { uploadsService } from '../services/uploads.service';

// config is declared readonly; tests flip these switches directly and restore them.
const cloudinary = config.cloudinary as {
  -readonly [K in keyof typeof config.cloudinary]: (typeof config.cloudinary)[K];
};
const CLOUD = config.cloudinary.cloudName;
const ROOT = config.cloudinary.uploadRoot;
const url = (path: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/${path}`;

describe('signUploadParams', () => {
  it("matches Cloudinary's published example", () => {
    // From cloudinary.com/documentation/authentication_signatures.
    const sig = signUploadParams(
      { timestamp: 1315060510, public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' },
      'abcd',
    );
    expect(sig).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('leaves api_key, file, cloud_name and resource_type out of the signed string', () => {
    const base = { public_id: 'x', timestamp: 1 };
    expect(
      signUploadParams({ ...base, api_key: 'k', file: 'f', cloud_name: 'c', resource_type: 'image' }, 's'),
    ).toBe(signUploadParams(base, 's'));
  });
});

describe('isCloudinaryUrlInFolders', () => {
  const folder = uploadFolder('user', 42);

  it('accepts the secure_url shape Cloudinary returns', () => {
    expect(isCloudinaryUrlInFolders(url(`v1700000000/${folder}/avatar.jpg`), [folder])).toBe(true);
  });

  it("rejects another user's folder", () => {
    expect(isCloudinaryUrlInFolders(url(`v1/${uploadFolder('user', 43)}/avatar.jpg`), [folder])).toBe(false);
  });

  it('rejects a sub-folder, a missing version, and a segment smuggled before the folder', () => {
    expect(isCloudinaryUrlInFolders(url(`v1/${folder}/nested/avatar.jpg`), [folder])).toBe(false);
    expect(isCloudinaryUrlInFolders(url(`${folder}/avatar.jpg`), [folder])).toBe(false);
    // Looks like a transformation, but on an unsigned upload it could be a folder name.
    expect(isCloudinaryUrlInFolders(url(`c_fill/v1/${folder}/avatar.jpg`), [folder])).toBe(false);
  });

  it('rejects a user ID that merely starts with ours', () => {
    expect(isCloudinaryUrlInFolders(url(`v1/${ROOT}/users/420/avatar.jpg`), [folder])).toBe(false);
  });

  it('rejects other clouds and other resource types', () => {
    expect(isCloudinaryUrlInFolders(`https://res.cloudinary.com/other/image/upload/v1/${folder}/a.jpg`, [folder])).toBe(false);
    expect(isCloudinaryUrlInFolders(`https://res.cloudinary.com/${CLOUD}/video/upload/v1/${folder}/a.mp4`, [folder])).toBe(false);
  });
});

describe('unsignedPhotoUrlError', () => {
  const folders = [uploadFolder('user', 42)];
  const legacy = url('v1/some-unsigned-upload.jpg');

  afterEach(() => {
    cloudinary.requireSignedUploads = false;
  });

  it('lets anything through while enforcement is off', () => {
    expect(unsignedPhotoUrlError(legacy, folders)).toBeNull();
  });

  it('rejects an unsigned URL once enforcement is on, but still allows clearing', () => {
    cloudinary.requireSignedUploads = true;
    expect(unsignedPhotoUrlError(legacy, folders)).toEqual({ photoUrl: [expect.any(String)] });
    expect(unsignedPhotoUrlError(url(`v1/${folders[0]}/avatar.png`), folders)).toBeNull();
    expect(unsignedPhotoUrlError(null, folders)).toBeNull();
    expect(unsignedPhotoUrlError(undefined, folders)).toBeNull();
  });
});

describe('uploadsService.createSignature', () => {
  beforeEach(() => {
    cloudinary.apiKey = 'test-key';
    cloudinary.apiSecret = 'test-secret';
    dbResult.rows = [];
  });

  afterEach(() => {
    cloudinary.apiKey = undefined;
    cloudinary.apiSecret = undefined;
  });

  it('pins a profile photo to a fixed, overwritable ID in the caller folder', async () => {
    const { uploadUrl, params, expiresAt } = await uploadsService.createSignature(42, 'user');
    expect(uploadUrl).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
    expect(params).toMatchObject({
      public_id: `${ROOT}/users/42/avatar`,
      asset_folder: `${ROOT}/users`,
      overwrite: true,
      invalidate: true,
      api_key: 'test-key',
    });
    const { api_key: _k, signature, ...signed } = params;
    expect(signature).toBe(signUploadParams(signed, 'test-secret'));
    expect(new Date(expiresAt).getTime() - Number(params.timestamp) * 1000).toBe(60 * 60 * 1000);
  });

  it('gives each one-off upload its own ID and never overwrites', async () => {
    const a = await uploadsService.createSignature(42, 'upload');
    const b = await uploadsService.createSignature(42, 'upload');
    expect(a.params.public_id).toMatch(new RegExp(`^${ROOT}/uploads/42/[0-9a-f-]{36}$`));
    expect(a.params.public_id).not.toBe(b.params.public_id);
    expect(a.params.asset_folder).toBe(`${ROOT}/uploads`);
    expect(a.params.overwrite).toBe(false);
    expect(a.params).not.toHaveProperty('invalidate');
  });

  it("signs a group photo for the group's owner", async () => {
    dbResult.rows = [{ id: 7 }];
    const { params } = await uploadsService.createSignature(42, 'group', 7);
    expect(params.public_id).toBe(`${ROOT}/groups/7/photo`);
    expect(params.asset_folder).toBe(`${ROOT}/groups`);
  });

  it('answers 404 to anyone who does not own the group', async () => {
    await expect(uploadsService.createSignature(42, 'group', 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 503 with a code while the API credentials are missing', async () => {
    cloudinary.apiSecret = undefined;
    await expect(uploadsService.createSignature(42, 'user')).rejects.toMatchObject({
      statusCode: 503,
      code: 'CLOUDINARY_NOT_CONFIGURED',
    });
  });
});
