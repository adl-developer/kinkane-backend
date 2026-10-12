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

**Changing or resetting a password now signs out every existing console
session for that admin.** Before, a console token stayed valid for its full 12
hours whatever happened to the password. A new `password_changed_at` column on
`admins` records each change, and any token issued before it is refused. This
covers all three ways a password can change: reset, change-password and
re-running `admin:create`.

`POST /admin/console/auth/change-password` therefore signs out the caller too.
Its response now also carries a fresh session (`token`, `expiresIn`, `admin`,
the same shape as login) alongside `changed: true`, and **the console must
swap that token in**, or its next request gets a 401.

The console needs a `/reset-password` page that reads `token` from the URL,
asks for the new password, and posts both to the second endpoint.

## Decisions

- **Its own token table** (`admin_password_reset_tokens`, migration 0077),
  separate from the customer `password_reset_tokens`. Admins are kept out of
  the customer tables on purpose, so that nothing in the customer auth stack
  can ever give a customer admin rights. Sharing the reset table would undo
  that.
- **The same answer, at the same speed, for every address.** The request
  endpoint says nothing about whether an email went out, so it can't be used to
  find out which staff addresses exist. It also answers *before* doing any work:
  for a real admin the work includes a database write, so waiting for it would
  let response time give the answer away. This is the same rule the login form
  follows, where `DUMMY_HASH` does the job.
- **Disabled admins get nothing.** No email is sent to them, and if someone is
  disabled after asking for a link, the link is refused when they use it. A
  password reset must not be a way back in for someone who has left.
- **30-minute, single-use links.** That is half the customer window. Only a
  hash of the token is stored, using the shared `hashToken` helper. There is
  one link per admin, enforced by a unique `admin_id`: asking again overwrites
  the previous link, even when two requests arrive at once. A link is checked
  before the new password is hashed, so a bad one costs a lookup rather than a
  bcrypt run. It is then consumed atomically, so two people using the same link
  at once can't both succeed.
- **Rate limits of their own.** Both endpoints share a per-IP bucket, 10 an
  hour, kept separate from login so that reset traffic from an office's shared
  IP can't lock staff out of signing in. Asking for a link is also limited to 3
  an hour per target address. Without that, anyone who knows a staff address
  could flood that inbox from many IPs, and every request would kill the link
  the admin was about to click.
- **The link's URL comes from the new `ADMIN_CONSOLE_URL` setting**, which
  defaults to `APP_URL/admin`. In production, CORS only allows `APP_URL`, so
  the console is assumed to be served from that origin. Set this if the
  console's reset page lives anywhere else.

## Left out

- **No "your password was changed" email.**
- **No way to sign out sessions without changing the password.** Disabling
  the account remains the way to do that.

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
- two simultaneous requests leaving exactly one link
- a session from before a reset refused, while a fresh login works
- change-password refusing every earlier session, the caller's included, and
  returning a session that works

All 11 tests pass. Unit tests cover the session cut-off, including a session
minted in the same second as the change surviving it, and the per-address
rate-limit key. The full unit suite (1424 tests), the endpoint contract suite
(with migrations 0077 and 0078 applied) and the typecheck also pass.
