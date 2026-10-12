# Let admins reset a forgotten password by email

**Date:** 2026-10-12

## What changed

An admin who has forgotten their console password can now reset it
themselves. Before, they could only change it while signed in, and an admin
who was locked out needed someone with shell access to run
`npm run admin:create`.

The flow uses two new public endpoints on the admin console API:

**`POST /admin/console/auth/forgot-password`**

```json
{ "email": "ama@kinkane.app" }
```

Always returns `200 { "sent": true }`. If the address belongs to an active
admin, they get an email with a link to
`<ADMIN_CONSOLE_URL>/reset-password?token=…`.

**`POST /admin/console/auth/reset-password`**

```json
{ "token": "<from the link>", "newPassword": "at least 12 characters" }
```

Returns `200 { "reset": true }`. If the link is unknown, expired, already used,
or belongs to a disabled admin, it returns `400` with
`code: "INVALID_RESET_TOKEN"`. It does not sign the admin in, so the console
should send them to the login screen afterwards.

The console needs a `/reset-password` page that reads `token` from the URL,
asks for the new password, and posts both to the second endpoint.

## Decisions

- **Its own token table** (`admin_password_reset_tokens`, migration 0077),
  separate from the customer `password_reset_tokens`. Admins are kept out of
  the customer tables on purpose, so that nothing in the customer auth stack
  can ever give a customer admin rights. Sharing the reset table would undo
  that.
- **The same answer for every address.** The request endpoint says nothing
  about whether an email went out, so it can't be used to find out which staff
  addresses exist. This is the same rule the login form follows.
- **Disabled admins get nothing.** No email is sent to them, and if someone is
  disabled after asking for a link, the link is refused when they use it. A
  password reset must not be a way back in for someone who has left.
- **30-minute, single-use links.** That is half the customer window. Only a
  hash of the token is stored. Asking again cancels the previous link. The
  token is consumed atomically, so two people using the same link at once
  can't both succeed.
- **Rate limited with the login bucket.** One endpoint sends email to any
  address it's given and the other accepts a guessed token, so both share the
  10-per-15-minutes-per-IP admin login limit.
- **The link's URL comes from the new `ADMIN_CONSOLE_URL` setting**, which
  defaults to `APP_URL/admin`. In production, CORS only allows `APP_URL`, so
  the console is assumed to be served from that origin. Set this if the
  console's reset page lives anywhere else.

## Left out

- **Existing console sessions are not signed out** after a reset. This matches
  `change-password`: a console token carries no password state, so there is
  nothing to revoke without adding a "password changed at" check to every
  admin request. Someone who has forgotten their password usually has no live
  session. If the concern is a stolen session, disable the account.
- **No "your password was changed" email.**

## Verification

`admin-password-reset.integration.test.ts` runs the real admin router over
HTTP against a scratch Postgres with every migration applied. It covers:

- the happy path, including a case-insensitive email
- the same response, with no email sent, for an address that isn't an admin
- no email for a disabled admin
- a link refused on second use
- an older link refused once a newer one was requested
- an expired link refused
- a link refused once the admin has been disabled
- a new password under 12 characters refused

All 8 tests pass. The full unit suite (1418 tests) and the typecheck also pass.
