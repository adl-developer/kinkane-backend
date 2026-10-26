# Author Digital Labs admin account is created on deploy

**Date:** 2026-10-26

## What changed

Every database setup run (`npm run db:init`, which Render runs before each deploy) now creates the
admin console account **admin@authordigitallabs.com** ("Author Digital Labs"). It only does this if
that email isn't already in the admins table. The password comes from a new `ADMIN_SEED_PASSWORD`
environment variable. `npm run seed:admin` runs the same seed by itself, for a local database.

## Why

The account was needed in both the local and the production database. The existing
`ADMIN_BOOTSTRAP_*` variables only create an admin while the admins table is **empty**, so they
can't add one to a database that already has staff. Seeding during setup means the account turns
up on prod with the deploy, with no one needing a shell on the server.

## Data / API shape

- **No migration and no API change.** The seed writes one row to `admins`.
- **New env var `ADMIN_SEED_PASSWORD`** (optional, at least 12 characters). It's documented in
  `.env.example` and is set per environment, in the Render dashboard for prod.

## Non-obvious decisions

- **The password isn't in the repo.** The email and name are in the code, but a committed password
  would be in the git history and every clone. That's why `ADMIN_BOOTSTRAP_*` takes its password
  from the environment too.
- **Insert-only.** If the email already exists, the seed leaves that account alone. Running it on
  every deploy therefore can't reset a password the admin has since changed, re-enable a disabled
  account, or sign anyone out. For any of those, use `npm run admin:create`.
- **A missing password skips the seed instead of failing.** Setup still runs on databases that don't
  have the variable set. `npm run seed:admin` does exit with an error in that case, because running
  it by hand is a clear sign the password was meant to be set.
- **The password is hashed with bcrypt at cost 10,** the same as the console login and
  `admin:create`. `bcryptjs` is called directly rather than through the admin auth service, so that
  setup doesn't load the app's config and database pool.

## Out of scope

- No change to `ADMIN_BOOTSTRAP_*` or `admin:create`.
- Nothing in `render.yaml`, which doesn't declare secrets. The variable is added in the dashboard.

## Verification

The server and the new script both typecheck. The seed hasn't been run against a database yet.
