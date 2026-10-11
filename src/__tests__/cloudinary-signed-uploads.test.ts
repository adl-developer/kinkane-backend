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

  it('lets anything through while enforcement is off', async () => {
    expect(await unsignedPhotoUrlError(legacy, folders)).toBeNull();
  });

  it('rejects an unsigned URL once enforcement is on, but still allows clearing', async () => {
    cloudinary.requireSignedUploads = true;
    expect(await unsignedPhotoUrlError(legacy, folders)).toEqual({ photoUrl: [expect.any(String)] });
    expect(await unsignedPhotoUrlError(url(`v1/${folders[0]}/avatar.png`), folders)).toBeNull();
    expect(await unsignedPhotoUrlError(null, folders)).toBeNull();
    expect(await unsignedPhotoUrlError(undefined, folders)).toBeNull();
  });

  it('accepts re-sending the photo already stored, so a whole-form edit still saves', async () => {
    cloudinary.requireSignedUploads = true;
    expect(await unsignedPhotoUrlError(legacy, folders, async () => legacy)).toBeNull();
    expect(await unsignedPhotoUrlError(legacy, folders, async () => url('v1/other.jpg'))).not.toBeNull();
    expect(await unsignedPhotoUrlError(legacy, folders, async () => null)).not.toBeNull();
  });

  it('only looks up the stored photo when the folder check fails', async () => {
    cloudinary.requireSignedUploads = true;
    const current = vi.fn(async () => null);
    await unsignedPhotoUrlError(url(`v1/${folders[0]}/a.png`), folders, current);
    expect(current).not.toHaveBeenCalled();
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

  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  it('signs a profile photo into the caller folder under a fresh, unguessable ID', async () => {
    const { uploadUrl, params, expiresAt } = await uploadsService.createSignature(42, { kind: 'user' });
    expect(uploadUrl).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
    expect(params.public_id).toMatch(new RegExp(`^${ROOT}/users/42/${UUID}$`));
    expect(params).toMatchObject({ asset_folder: `${ROOT}/users`, api_key: 'test-key' });
    const { api_key: _k, signature, ...signed } = params;
    expect(signature).toBe(signUploadParams(signed, 'test-secret'));
    expect(new Date(expiresAt).getTime() - Number(params.timestamp) * 1000).toBe(60 * 60 * 1000);
  });

  it('never overwrites: a second profile photo gets a different ID', async () => {
    // Overwriting a fixed ID would change the visible photo before the client
    // saved the new URL, and a fixed ID can be guessed from the user ID.
    const a = await uploadsService.createSignature(42, { kind: 'user' });
    const b = await uploadsService.createSignature(42, { kind: 'user' });
    expect(a.params.public_id).not.toBe(b.params.public_id);
    expect(a.params).not.toHaveProperty('overwrite');
    expect(a.params).not.toHaveProperty('invalidate');
  });

  it('converts formats browsers cannot show (HEIC) to jpg instead of storing them', async () => {
    const { params } = await uploadsService.createSignature(42, { kind: 'user' });
    expect(String(params.allowed_formats).split(',')).not.toContain('heic');
    expect(params.format).toBe('jpg');
  });

  it('files one-off uploads under the caller uploads folder', async () => {
    const { params } = await uploadsService.createSignature(42, { kind: 'upload' });
    expect(params.public_id).toMatch(new RegExp(`^${ROOT}/uploads/42/${UUID}$`));
    expect(params.asset_folder).toBe(`${ROOT}/uploads`);
  });

  it("signs a group photo for the group's owner", async () => {
    dbResult.rows = [{ id: 7 }];
    const { params } = await uploadsService.createSignature(42, { kind: 'group', groupId: 7 });
    expect(params.public_id).toMatch(new RegExp(`^${ROOT}/groups/7/${UUID}$`));
    expect(params.asset_folder).toBe(`${ROOT}/groups`);
  });

  it('answers 404 to anyone who does not own the group', async () => {
    await expect(uploadsService.createSignature(42, { kind: 'group', groupId: 7 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 503 with a code while the API credentials are missing', async () => {
    cloudinary.apiSecret = undefined;
    await expect(uploadsService.createSignature(42, { kind: 'user' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'CLOUDINARY_NOT_CONFIGURED',
    });
  });
});
