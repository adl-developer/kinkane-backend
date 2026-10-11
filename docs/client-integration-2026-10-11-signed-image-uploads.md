# Client integration brief: signed image uploads, 11 Oct 2026

Profile and group photos should now be uploaded with a **signature from our
server** instead of the unsigned Cloudinary upload preset. The image still goes
straight from the phone to Cloudinary; only a small signing request goes
through our API.

Why: with the unsigned preset, anyone could upload anything to our account and
set any URL as a photo. Signed uploads tie each image to the user or group it
belongs to, and the server will soon reject photos that weren't signed.

**Status:** on branch `feat/cloudinary-signed-uploads` in `kinkane-backend`,
pushed but not merged. It isn't live on any environment yet. We'll confirm when
it's deployed. Nothing changes for current app builds until we switch on
enforcement (see "Rollout" below).

All paths are under `/api/v1`. Full shapes are in the OpenAPI docs at `/docs`
(Account & Settings → "Sign an image upload to Cloudinary").

---

## Checklist

- [ ] **Profile photo:** sign with `kind: "user"`, upload, then `PATCH /user/settings/profile`.
- [ ] **Edit group photo:** sign with `kind: "group"` and the `groupId`, upload, then `PATCH /groups/:groupId`.
- [ ] **Create group with a photo:** sign with `kind: "upload"`, upload, then `POST /groups`.
- [ ] **Remove the unsigned preset** (its name and any upload code using it) from the app.
- [ ] **Store `secure_url` exactly as Cloudinary returns it.** Don't add resize or crop settings to the stored URL.
- [ ] Resize or compress big photos before uploading (see "Before uploading").

## The flow

Three steps, every time:

1. **Sign:** `POST /uploads/signature` → `{ uploadUrl, params, expiresAt }`
2. **Upload:** `POST` the image to `uploadUrl` as `multipart/form-data`, with
   `file` plus **every field in `params`, unchanged**. Cloudinary returns
   `secure_url`.
3. **Save:** send `secure_url` as `photoUrl` to the profile or group endpoint,
   exactly as before.

Get a fresh signature for each upload. Don't cache or reuse one.

## Which `kind` to use

| Screen | Sign with | Then save with |
|---|---|---|
| Change my profile photo | `{ "kind": "user" }` | `PATCH /user/settings/profile` |
| Change a group's photo (owner only) | `{ "kind": "group", "groupId": 7 }` | `PATCH /groups/7` |
| Pick a photo while **creating** a group | `{ "kind": "upload" }` | `POST /groups` |

The group doesn't exist yet when it's being created, so there's no `groupId` to
sign for. That's what `kind: "upload"` is for. A `kind: "upload"` image is also
accepted by the profile and edit-group endpoints, so use it if a screen doesn't
fit the table.

`groupId` must be a JSON number, not a string.

## Step 1: sign

`POST /uploads/signature` (signed in)

```json
{ "kind": "user" }
```

200:

```json
{
  "uploadUrl": "https://api.cloudinary.com/v1_1/dy0cthb0l/image/upload",
  "params": {
    "public_id": "kinkane/users/42/avatar",
    "asset_folder": "kinkane/users",
    "timestamp": 1791717811,
    "allowed_formats": "jpg,jpeg,png,webp,heic,heif",
    "overwrite": true,
    "invalidate": true,
    "api_key": "556…",
    "signature": "d8cf9dce4db066c51b4abb94a0fb0e4e6111381e"
  },
  "expiresAt": "2026-10-11T12:43:31.000Z"
}
```

**Treat `params` as an opaque bag.** Send every key, don't add any, don't
change any. The set of keys differs by kind (`invalidate` only appears for
`user` and `group`), so loop over the object instead of picking fields by name.

Errors:

| Status | When | What to do |
|---|---|---|
| 400 | Bad body, e.g. `kind: "group"` without `groupId` | Bug, fix the request |
| 401 | Not signed in | Usual auth handling |
| 404 | Group doesn't exist or the user doesn't own it | Hide "change photo" for non-owners. You'll never see a 403 here |
| 429 | Over 30 signatures in 15 minutes | "Try again in a few minutes" |
| 503 `CLOUDINARY_NOT_CONFIGURED` | Server isn't set up for uploads | "Photo uploads are unavailable right now" |

## Step 2: upload to Cloudinary

This request goes to **Cloudinary**, not our API. Don't send our
`Authorization` header.

```ts
async function uploadImage(kind: 'user' | 'upload' | 'group', image: { uri: string; mimeType?: string }, groupId?: number) {
  // 1. Sign
  const sig = await api.post('/uploads/signature', kind === 'group' ? { kind, groupId } : { kind });

  // 2. Upload straight to Cloudinary
  const form = new FormData();
  form.append('file', {
    uri: image.uri,
    name: 'photo.jpg',
    type: image.mimeType ?? 'image/jpeg',
  } as any);
  for (const [key, value] of Object.entries(sig.params)) {
    form.append(key, String(value)); // booleans become "true"/"false", which Cloudinary expects
  }

  const res = await fetch(sig.uploadUrl, { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Upload failed');

  return body.secure_url as string;
}
```

Don't set `Content-Type` yourself. `fetch` adds the multipart boundary.

Cloudinary's 200 response includes `secure_url`, `public_id`, `version`,
`width`, `height`, `format` and `bytes`. You only need `secure_url`.

Errors from Cloudinary come back as `{ "error": { "message": "…" } }`:

| Status | Message starts with | Cause |
|---|---|---|
| 401 / 400 | `Invalid Signature` | A field in `params` was changed, added or dropped. Sign again |
| 400 | `Stale request` | The signature is more than an hour old. Sign again |
| 400 | `Image file format … not allowed` | Not jpg, jpeg, png, webp, heic or heif |
| 400 | `File size too large` | Over the account limit. Compress first |

A simple rule for the app: on any Cloudinary error, get a new signature and
retry once, then show "Couldn't upload that photo".

## Step 3: save the URL

Unchanged from today: send `secure_url` as `photoUrl`.

```http
PATCH /user/settings/profile
{ "photoUrl": "https://res.cloudinary.com/dy0cthb0l/image/upload/v1791717811/kinkane/users/42/avatar.jpg" }
```

`{ "photoUrl": null }` still removes the photo.

Once enforcement is on, a `photoUrl` that wasn't signed for this user or group
gets:

```json
400 { "error": { "photoUrl": ["photoUrl must be an image uploaded with a signature from POST /uploads/signature"] } }
```

That's the same field-error shape as other validation errors. You'd only see it
if the app saved an old-style URL, someone else's URL, or a URL it had changed.

## Things that will catch you out

- **Store the URL exactly as returned.** The server only accepts the shape
  Cloudinary returns: `…/image/upload/v<number>/<folder>/<file>`. If you want a
  thumbnail, add resize settings when you *display* the image (e.g.
  `…/image/upload/w_200,h_200,c_fill/v…`), never in what you save.
- **A new profile photo keeps the same name but gets a new URL.** Each upload
  replaces the previous avatar, and the `v<number>` part of the URL changes.
  Always save the new `secure_url`, then refresh the screen from the response.
  Don't rebuild the URL yourself, or users will keep seeing the cached old
  photo.
- **A signature lasts one hour**, and Cloudinary fixes that. Sign right before
  uploading, not when the screen opens.
- **Upload first, save second.** If the user cancels after the upload but
  before saving, nothing changes on their profile. For profile and group photos
  the next upload simply replaces the orphaned image.
- **Only the owner can change a group's photo.** Members asking for a `group`
  signature get a 404.

## Before uploading

We can't cap file size in the signature, so please keep uploads small on the
phone:

- Resize to at most **2048px** on the longest side, and compress to JPEG at
  around 0.8 quality. `expo-image-manipulator` does both.
- HEIC from the iOS picker is accepted as-is, but converting to JPEG during
  that resize step is simplest and works everywhere.

## Rollout

1. **Backend deploy:** the signing endpoint goes live. The old unsigned preset
   keeps working, and any URL in our Cloudinary account is still accepted.
2. **App release:** ship builds that use signed uploads.
3. **Enforcement:** once most users have updated, we turn on the ownership
   check and remove the unsigned preset. From then on, **old builds can't
   change photos** (they'll get the 400 above). Existing photos keep showing
   either way.

Before step 3, tell us which minimum app version is safe, and consider
prompting older builds to update.

## Testing

A Postman collection, **Kinkane Uploads**, runs all three steps:

1. Run one of the "Sign …" requests.
2. Pick a file in "Upload image to Cloudinary" and send it.
3. Run one of the "Store the URL" requests.

Scripts pass the values between the requests. Ask the backend team for the
collection file.
