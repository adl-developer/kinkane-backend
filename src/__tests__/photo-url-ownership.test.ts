import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Which signed-upload folders each photo-saving endpoint accepts once
 * CLOUDINARY_REQUIRE_SIGNED_UPLOADS is on. The helper's rules are pinned in
 * cloudinary-signed-uploads.test.ts; this covers the wiring — that each
 * controller passes the right folders for the right ID, and checks before it
 * writes. A swapped ID here would silently let one user set another's photo.
 */

const { groups, settings } = vi.hoisted(() => ({
  groups: { create: vi.fn(), update: vi.fn(), getPhotoUrl: vi.fn() },
  settings: { updateProfile: vi.fn(), getPhotoUrl: vi.fn() },
}));

vi.mock('../services/groups.service', () => ({ groupsService: groups }));
vi.mock('../services/group-books.service', () => ({ groupBooksService: {} }));
vi.mock('../controllers/group-books.controller', () => ({ withShelfReviews: vi.fn() }));
vi.mock('../services/auth.service', () => ({ authService: {} }));
vi.mock('../services/user-settings.service', () => ({ userSettingsService: settings }));
vi.mock('../services/usernames.service', () => ({ usernamesService: {} }));

import { config } from '../config';
import { uploadFolder } from '../lib/cloudinary-url';
import { groupsController } from '../controllers/groups.controller';
import { userSettingsController } from '../controllers/user-settings.controller';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import type { Response } from 'express';

const cloudinary = config.cloudinary as { requireSignedUploads: boolean };
const ME = 42;
const OTHER = 43;
const GROUP = 7;
const signed = (folder: string) =>
  `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/upload/v1791717811/${folder}/0b5e.jpg`;
const LEGACY = `https://res.cloudinary.com/${config.cloudinary.cloudName}/image/upload/v1785093900/old_preset.jpg`;

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const req = (body: unknown, params: Record<string, string> = {}) =>
  ({ body, params, query: {}, user: { id: ME, email: 'me@test' } }) as unknown as AuthenticatedRequest;

async function run(handler: (r: AuthenticatedRequest, s: Response) => Promise<void>, r: AuthenticatedRequest) {
  const res = fakeRes();
  await handler(r, res as unknown as Response);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  cloudinary.requireSignedUploads = true;
  groups.create.mockResolvedValue({ id: GROUP });
  groups.update.mockResolvedValue({ id: GROUP });
  groups.getPhotoUrl.mockResolvedValue(null);
  settings.updateProfile.mockResolvedValue({ name: 'Me', photoUrl: null, phone: null });
  settings.getPhotoUrl.mockResolvedValue(null);
});

afterEach(() => {
  cloudinary.requireSignedUploads = false;
});

describe('PATCH /user/settings/profile', () => {
  const save = (photoUrl: string | null) => run(userSettingsController.updateProfile, req({ photoUrl }));

  it.each([
    ['my users folder', uploadFolder('user', ME)],
    ['my uploads folder', uploadFolder('upload', ME)],
  ])('accepts a photo from %s', async (_label, folder) => {
    const res = await save(signed(folder));
    expect(res.statusCode).toBe(200);
    expect(settings.updateProfile).toHaveBeenCalled();
  });

  it.each([
    ["another user's users folder", uploadFolder('user', OTHER)],
    ["another user's uploads folder", uploadFolder('upload', OTHER)],
    ['a group folder', uploadFolder('group', ME)],
  ])('rejects a photo from %s without writing', async (_label, folder) => {
    const res = await save(signed(folder));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { photoUrl: [expect.any(String)] } });
    expect(settings.updateProfile).not.toHaveBeenCalled();
  });

  it('accepts the legacy photo already on the profile, so a name change still saves', async () => {
    settings.getPhotoUrl.mockResolvedValue(LEGACY);
    const res = await run(userSettingsController.updateProfile, req({ name: 'New', photoUrl: LEGACY }));
    expect(res.statusCode).toBe(200);
    expect(settings.getPhotoUrl).toHaveBeenCalledWith(ME);
  });

  it('rejects a legacy photo that is not the stored one', async () => {
    settings.getPhotoUrl.mockResolvedValue(signed(uploadFolder('user', ME)));
    expect((await save(LEGACY)).statusCode).toBe(400);
  });

  it('returns a 500 rather than crashing when the stored-photo lookup fails', async () => {
    settings.getPhotoUrl.mockRejectedValue(new Error('db down'));
    expect((await save(LEGACY)).statusCode).toBe(500);
  });

  it('accepts anything in our cloud while enforcement is off', async () => {
    cloudinary.requireSignedUploads = false;
    expect((await save(LEGACY)).statusCode).toBe(200);
  });
});

describe('POST /groups', () => {
  const create = (photoUrl: string) => run(groupsController.create, req({ name: 'Club', photoUrl }));

  it('accepts a photo from my uploads folder', async () => {
    expect((await create(signed(uploadFolder('upload', ME)))).statusCode).toBe(201);
  });

  it.each([
    ['a groups folder (the group has no ID yet)', uploadFolder('group', GROUP)],
    ['my profile folder', uploadFolder('user', ME)],
    ["another user's uploads folder", uploadFolder('upload', OTHER)],
    ['a legacy upload', null],
  ])('rejects a photo from %s without creating', async (_label, folder) => {
    const res = await create(folder ? signed(folder) : LEGACY);
    expect(res.statusCode).toBe(400);
    expect(groups.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /groups/:groupId', () => {
  const update = (photoUrl: string, body: object = {}) =>
    run(groupsController.update, req({ ...body, photoUrl }, { groupId: String(GROUP) }));

  it.each([
    ["this group's folder", uploadFolder('group', GROUP)],
    ['my uploads folder', uploadFolder('upload', ME)],
  ])('accepts a photo from %s', async (_label, folder) => {
    expect((await update(signed(folder))).statusCode).toBe(200);
    expect(groups.update).toHaveBeenCalled();
  });

  it.each([
    ["another group's folder", uploadFolder('group', GROUP + 1)],
    ["another user's uploads folder", uploadFolder('upload', OTHER)],
    ['my profile folder', uploadFolder('user', ME)],
  ])('rejects a photo from %s without writing', async (_label, folder) => {
    expect((await update(signed(folder))).statusCode).toBe(400);
    expect(groups.update).not.toHaveBeenCalled();
  });

  it("accepts the group's current legacy photo, so a rename still saves", async () => {
    groups.getPhotoUrl.mockResolvedValue(LEGACY);
    const res = await update(LEGACY, { name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(groups.getPhotoUrl).toHaveBeenCalledWith(GROUP);
  });
});
