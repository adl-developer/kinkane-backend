import { describe, it, expect } from 'vitest';
import { createGroupSchema, updateGroupSchema } from '../lib/group-input';
import { config } from '../config';

// These pin the two validation rules that, when they fail, do not look like
// validation failures. A whitespace name produces a group that renders blank
// everywhere rather than an error, and an over-long photo URL fails inside
// Postgres as an untagged error, which reaches the caller as a 500.

const CLOUD = config.cloudinary.cloudName;
const cloudinaryUrl = (pathLength: number) =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/${'a'.repeat(pathLength)}.jpg`;

describe('group name', () => {
  it('rejects a name that is only whitespace', () => {
    // Zod applies string checks in declaration order, so the obvious
    // `.min(1).max(100).trim()` accepts "   " — it clears min(1) at its full
    // length and is only trimmed to "" afterwards. Trimming has to come first.
    const r = createGroupSchema.safeParse({ name: '   ' });
    expect(r.success).toBe(false);
  });

  it('never yields an empty name from a successful parse', () => {
    // The property that actually matters downstream: whatever comes out of a
    // successful parse is safe to store and display.
    for (const name of ['  Books & Friends  ', '\tBook Club\n', 'A']) {
      const r = createGroupSchema.safeParse({ name });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.name.length).toBeGreaterThan(0);
    }
  });

  it('trims surrounding whitespace off a stored name', () => {
    const r = createGroupSchema.safeParse({ name: '  Books & Friends  ' });
    expect(r.success && r.data.name).toBe('Books & Friends');
  });

  it('measures length after trimming, not before', () => {
    // 100 characters plus padding is a 100-character name, and rejecting it
    // would be a confusing 400 for a name the user can see is short enough.
    const r = createGroupSchema.safeParse({ name: `  ${'a'.repeat(100)}  ` });
    expect(r.success).toBe(true);
    const tooLong = createGroupSchema.safeParse({ name: 'a'.repeat(101) });
    expect(tooLong.success).toBe(false);
  });

  it('applies the same rule when renaming', () => {
    // The update path is the one that could quietly blank out an existing
    // group that already had a good name.
    expect(updateGroupSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
});

describe('group photo URL', () => {
  it('rejects a URL longer than the column can hold', () => {
    // groups.photo_url is varchar(500). Without this cap Postgres raises
    // 22001, which carries no statusCode and so reaches the client as a
    // generic 500 rather than a 400 naming the field.
    const r = createGroupSchema.safeParse({ name: 'Club', photoUrl: cloudinaryUrl(600) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? {} : r.error.flatten().fieldErrors)).toContain('500 characters');
  });

  it('accepts a realistic Cloudinary URL', () => {
    const r = createGroupSchema.safeParse({ name: 'Club', photoUrl: cloudinaryUrl(40) });
    expect(r.success).toBe(true);
  });

  it('still rejects another Cloudinary account, short or not', () => {
    // The length cap must not become the only check standing.
    const r = createGroupSchema.safeParse({
      name: 'Club',
      photoUrl: 'https://res.cloudinary.com/someone-else/image/upload/v1/x.jpg',
    });
    expect(r.success).toBe(false);
  });

  it('accepts null to clear the photo', () => {
    expect(updateGroupSchema.safeParse({ photoUrl: null }).success).toBe(true);
  });
});

describe('group update', () => {
  it('rejects a patch that changes nothing', () => {
    // A silent 200 on an empty body hides a client bug.
    expect(updateGroupSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a privacy-only patch', () => {
    // This is exactly what the standalone Privacy Settings screen sends.
    expect(updateGroupSchema.safeParse({ privacy: 'private' }).success).toBe(true);
  });
});
