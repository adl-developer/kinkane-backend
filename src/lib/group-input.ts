import { z } from 'zod';
import { isCloudinaryUrl, cloudinaryUrlMessage } from './cloudinary-url';

/**
 * Request shapes for creating and editing a group.
 *
 * These live here rather than at the top of the controller — the usual home for
 * zod in this codebase — because the controller imports `authService`, which
 * initialises Firebase on load. A unit test that imported the controller just to
 * reach a schema would need Firebase credentials to do it. `lib/phone.ts` shares
 * `phoneSchema` the same way and for the same reason.
 */

// `.trim()` comes BEFORE the length checks, not after. Zod applies string checks
// in declaration order, so the natural-looking `.min(1).max(100).trim()` accepts
// a name of pure whitespace: it clears min(1) at its untrimmed length and is only
// then collapsed to an empty string — precisely what min(1) is there to stop.
export const groupNameSchema = z.string().trim().min(1).max(100);

// The client uploads to Cloudinary itself and sends us the resulting URL, so
// both the origin check and the length cap have to happen here. `groups.photo_url`
// is varchar(500); without the cap a longer URL passes validation and fails in
// Postgres as an untagged 22001, which reaches the caller as a 500 rather than a
// 400 naming the field.
export const groupPhotoUrlSchema = z
  .string()
  .url()
  .max(500, 'photoUrl must be 500 characters or fewer')
  .refine(isCloudinaryUrl, { message: cloudinaryUrlMessage('photoUrl') });

export const createGroupSchema = z.object({
  name: groupNameSchema,
  description: z.string().max(2000).nullable().optional(),
  photoUrl: groupPhotoUrlSchema.nullable().optional(),
  privacy: z.enum(['public', 'private']).default('public'),
});

// Every field optional, but at least one required — a PATCH that changes nothing
// is a client bug worth surfacing rather than a silent 200.
export const updateGroupSchema = z
  .object({
    name: groupNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    photoUrl: groupPhotoUrlSchema.nullable().optional(),
    privacy: z.enum(['public', 'private']).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'At least one of name, description, photoUrl or privacy must be provided',
  });
