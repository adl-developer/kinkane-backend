# CI checks every change before it can deploy

## What changed

The backend now has continuous integration on GitHub Actions
(`.github/workflows/ci.yml`). It runs on every pull request and on every push
to `main`, as two jobs:

- **Typecheck and unit tests.** `npm run build` (which is `tsc`) and `npm test`.
  No services are needed: the unit suite already runs on the fixed fake
  environment in `src/__tests__/support/hermetic-env.ts`.
- **Database checks.** These run against a throwaway Postgres 18 with pgvector,
  plus Redis:
  1. `npm run db:init` on an empty database. This is exactly Render's
     `preDeployCommand`, so a migration that would fail the deploy fails here
     first.
  2. A schema-drift check. It runs `drizzle-kit generate` and fails if that
     writes anything to `drizzle/`, which means the schema has a change with no
     migration behind it.
  3. The endpoint contract suite (`npm run test:endpoints`), run against a
     one-book fixture (`.github/ci/fixtures.sql`).
  4. The integration suite (`npm run test:integration`), run against a second
     database of its own.

`render.yaml` now sets `autoDeployTrigger: checksPass`, so Render deploys a push
to `main` only after these checks pass on that commit.

## Why

Until now the only gate was the pre-commit hook, and it has two gaps.
`--no-verify` skips it. And with no local database running, it only *warns*
about the endpoint suite, which is the suite that catches schema drift. Render
deployed every push regardless, and it runs migrations against production
before each deploy. A broken migration or a missing column could therefore
reach production unseen.

## Decisions worth knowing

- **The database is created with the C locale.** Production's database uses
  collate/ctype `C`, so POSIX regex classes there only recognise ASCII letters:
  `'É' ~ '[[:alpha:]]'` is false. A default Postgres container uses
  `en_US.UTF-8`, where the same match is true. Accent-handling SQL would then
  pass in CI and misfile text in production. CI matches production instead. We
  verified this: `'É' ~ '[[:alpha:]]'` returns `false` in the CI database and
  `true` under `COLLATE "und-x-icu"`.
- **Two databases, not one.** The integration tests truncate tables, and they
  refuse to run on the database the endpoint suite reads. `kinkane_ci` serves
  the endpoint suite and `kinkane_integration` serves the integration tests.
  Both are migrated.
- **A one-book fixture, not an empty catalogue.** The endpoint suite picks real
  ids so that parameterised routes hit a row that exists. The bug the suite was
  written for lived on that path, so on an empty database "serves a book by id"
  fails with a 404. Loosening that test would defeat its purpose, so CI
  supplies one book, one genre and one contributor instead.
- **A throwaway Firebase key.** The app parses the Firebase private key when it
  starts, so a placeholder string makes it crash. CI generates a fresh RSA key
  on each run. The key belongs to no Firebase project.
- **Every secret is a placeholder.** Neither suite sends mail, calls Gemini or
  uploads an image, so no real credentials live in GitHub.
- **Node 22.** This is the current LTS release. `package.json` has no `engines`
  field yet, so this is not pinned to whatever Render runs.

## Out of scope

- Linting and formatting. Neither is configured in the repo yet.
- The ONIX ingester, which gets its own workflow separately.
- Dependabot and `npm audit`.

## How it was verified

We ran every step locally against the same `pgvector/pgvector:pg18` image with
the same locale settings, from a clean copy of the repo with no `.env`:

- The typecheck passed, and the unit suite passed (1268 tests).
- Both databases migrated from empty without errors.
- On `main`, `drizzle-kit generate` reported "No schema changes". We then added a
  column to the schema with no migration, and the check caught it.
- The endpoint contract suite passed (31 tests) once the fixture was loaded.
  Without the fixture it failed only the book-by-id test, as expected.
- The integration suite passed (29 tests across 3 files).
