# Profiles include the full sign-up date

## What changed

Both profile responses now carry **`joinedAt`**, the full timestamp of when the account was created
(ISO 8601, UTC):

- `GET /auth/me` → `user.joinedAt`, next to `joinedYear`
- `GET /users/:userId` → `joinedAt`, next to `yearJoined`

```json
{ "joinedYear": 2026, "joinedAt": "2026-03-14T09:21:07.512Z" }
```

## Why

The app only had the year, so it could show "Joined 2026" but nothing more precise, such as
"Joined March 2026".

## Decisions

- **Additive.** `joinedYear` and `yearJoined` stay as they are, so app builds already in the wild
  keep working. They can be retired once every client reads `joinedAt`.
- **One name on both endpoints.** The year fields are named differently on the two endpoints, which
  is a known inconsistency. The new field uses the same name, `joinedAt`, on both so it doesn't
  repeat that.
- **Full timestamp, in UTC.** Format it in the viewer's time zone on the device. The year fields are
  worked out in the server's time zone, so near New Year they can disagree with `joinedAt`
  formatted on the device. Trust `joinedAt`.

## Out of scope

- Renaming `joinedYear`/`yearJoined` to match each other, or removing them.
- Adding the date anywhere else people are listed (search results, follower lists).

## How it was verified

The project type-checks cleanly, and the existing `/auth/me` test (`trial-expiry.test.ts`) still
passes. Both values come straight from `users.created_at`, the same column the year fields already
use.
