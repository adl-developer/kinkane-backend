# Google sign-in no longer fails for people with long profile photo links

## What changed

`users.photo_url` is now `text` instead of `varchar(1000)` (migration
`0084_user_photo_url_text`). Social sign-in also checks the provider's photo URL
before storing it. If the URL is missing, isn't http(s), or is longer than 8,192
characters, the account is created without a photo and sign-in continues. When a
returning account links Google and has no photo yet, the photo is backfilled. If
that backfill fails, it's logged and skipped instead of failing the sign-in.

## Why

`POST /api/v1/auth/social` returned a 500 for a real Google account. The Firebase
token verified correctly. The sign-in then failed when it copied the account's
Google photo URL into the user row: that URL was 1,129 characters, and Postgres
rejected it with `value too long for type character varying(1000)`. Google photo
URLs for custom profile pictures can be this long, so this was locking out
anyone who had one, both for sign-up and for linking Google to an existing
email account.

## Decisions

- **`text`, not a bigger varchar.** Postgres stores both the same way. Any fixed
  limit would just be the next one a provider runs past.
- **Still check the URL.** The column no longer limits length, so the service
  layer decides what's worth keeping. A profile photo is decoration and should
  never cost someone their sign-in.
- The check lives in `src/lib/social-photo-url.ts` so it can be unit-tested
  without loading Firebase or the database.

## Out of scope

- `groups.photo_url` (varchar 500) and the profile-update endpoint's photo
  field. Both only take Cloudinary URLs we create ourselves, so they never see
  provider URLs.

## Verification

- Unit tests for the URL check, including a 1,100+ character Google-style URL.
  The full unit suite passes (96 files, 1,528 tests), and `tsc` is clean.
- Reproduced the 500 against the current code with the failing account's real
  Firebase token. On a scratch database migrated to this branch, the same token
  signed up and then signed in again, and the full 1,129-character photo URL was
  stored.
