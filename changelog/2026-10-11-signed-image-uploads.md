# Signed image uploads to Cloudinary

## What changed

New endpoint, `POST /api/v1/uploads/signature`. It hands the app a short-lived
signature so the app can upload an image **straight to Cloudinary**. The image
never passes through our server. The app then sends the resulting URL to the
endpoint that stores it, the same as today.

Previously the app uploaded through an *unsigned* preset. Anyone holding the
preset name could put any image anywhere in our account, and the server had no
way to tell whose image a URL was. It only checked that the URL was in our
Cloudinary account.

## API

```
POST /api/v1/uploads/signature
{ "kind": "user" }                    // your profile photo
{ "kind": "group", "groupId": 7 }     // a group you own
{ "kind": "upload" }                  // anything else, incl. a photo for a group not created yet

200 {
  "uploadUrl": "https://api.cloudinary.com/v1_1/<cloud>/image/upload",
  "params": { "public_id", "asset_folder", "timestamp", "allowed_formats", "overwrite", "invalidate"?, "api_key", "signature" },
  "expiresAt": "…"
}
```

The client POSTs `multipart/form-data` to `uploadUrl` with `file` plus every
field in `params`, unchanged, and stores Cloudinary's `secure_url`.

Errors: 400 for a bad body, 404 when the group is missing or not the caller's,
429 above 30 per 15 minutes per user, and 503 `CLOUDINARY_NOT_CONFIGURED` when
the API key and secret aren't set.

## Where images land

| kind | public ID | replaces previous? |
|---|---|---|
| user | `<root>/users/<userId>/avatar` | yes, with CDN invalidation |
| group | `<root>/groups/<groupId>/photo` | yes, with CDN invalidation |
| upload | `<root>/uploads/<userId>/<uuid>` | no |

`<root>` is `CLOUDINARY_UPLOAD_ROOT` (default `kinkane`).

In the Media Library, images are filed into one folder per kind:
`<root>/users`, `<root>/groups` and `<root>/uploads`. The account uses
dynamic folders, so the public ID path alone wouldn't create them. That folder
is only for browsing. Ownership is always checked against the public ID.

## Ownership check

With `CLOUDINARY_REQUIRE_SIGNED_UPLOADS=true`, a stored `photoUrl` must sit
directly in a folder signed for the caller:

- `PATCH /user/settings/profile`: `users/<me>` or `uploads/<me>`
- `POST /groups`: `uploads/<me>`
- `PATCH /groups/:id`: `groups/<id>` or `uploads/<me>`

Anything else gets a 400 on `photoUrl`. Clearing a photo with `null` is always
allowed.

## Non-obvious decisions

- **No uploads table.** The signed `public_id` fixes the folder. Cloudinary
  rejects the upload if the client changes it, so the folder in the URL proves
  ownership by itself.
- **The URL check is strict.** It only accepts `/<cloud>/image/upload/v<n>/<folder>/<file>`,
  which is exactly what Cloudinary returns. It allows no transformation
  segments and no sub-folders. While the unsigned preset still exists, a lenient
  match would let someone dress up an unsigned upload's path to look like a
  signed folder.
- **Fixed IDs for avatars and group photos.** A new photo replaces the old one
  instead of leaving orphans. The version number in the URL changes on every
  upload, so caches refresh without extra work.
- **Enforcement is off by default.** App builds already in users' hands upload
  unsigned. Turning enforcement on at deploy would break their photo changes.
- **No Cloudinary SDK.** Signing is one SHA-1 over sorted params. A test checks
  the hand-rolled version against Cloudinary's published example.
- **Per-environment root folder.** Fixed IDs mean dev and prod would overwrite
  each other's avatars if they shared a cloud and a root.

## Out of scope / limits

- **File size.** Cloudinary has no signed upload parameter that caps size. The
  account-level limit applies. Set a lower one in Cloudinary's upload settings
  if needed, and have the app check before uploading.
- **Signature lifetime.** Cloudinary fixes it at one hour. We can't shorten it.
- **Removing the unsigned preset.** That's a dashboard step, to do after
  enforcement is on.
- **Cleanup.** Orphaned one-off uploads are not cleaned up.

## Verification

Unit tests (`cloudinary-signed-uploads.test.ts`) cover:

- the signature against Cloudinary's documented example
- which fields are excluded from signing
- folder pinning and owner-only group signing
- the 503 when the API key and secret are missing
- the URL ownership check, including another user's folder, a prefix lookalike
  ID, nested paths, a smuggled segment, other clouds, and video URLs
- the enforcement switch

Full suite and typecheck pass.

End to end against the real account, with the server running locally and
enforcement on (root `kinkane-test`):

- all three kinds sign, upload to Cloudinary, and are accepted by the profile
  and group endpoints
- a tampered `public_id` is rejected by Cloudinary as `Invalid Signature`
- another user storing someone's avatar URL gets a 400
- signing a group photo as a non-owner gets a 404
- replacing an avatar with a new image keeps the public ID and gets a new
  version

The API key needs a role that can create assets (Master Admin). With
*Media Library User* every upload got a 403.
