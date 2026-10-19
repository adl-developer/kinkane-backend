# Referral analytics and the Travellers list in the admin console

## What changed

Two read-only endpoints on the admin console, behind the normal staff sign-in (`requireAdmin`):

- **`GET /admin/console/referrals/analytics`**: totals for the whole competition (referrals sent, link clicks, signups, successful/verified signups, conversion rate, countries and continents reached, and the number of Travellers), plus one weekly bucket per campaign week. Each bucket has the sent and converted counts and a running **cumulative** signups total.
- **`GET /admin/console/referrals/travellers?q=&sort=&limit=&offset=`**: every Traveller, paginated (max 100 a page). Each row has the person's full name, username, email, country and city, who referred them, and their own invites sent, clicks, signups, successful, pending, countries reached and points. `sort` is `points` (default), `signups` (verified) or `recent`. `q` searches name, email and username.

## Why

The client asked for full referral analytics for admins: total referrals sent, successful signups, countries reached, the weekly referrals chart, cumulative signups and a list of all Travellers. The figures already existed on the public `/api/v1/referrals/analytics`, but the console had nothing. The only admin referral routes sat behind the machine `ADMIN_TOKEN`, which the console cannot use. They returned a points leaderboard capped at 500 that left out anyone without points.

## Decisions

- **A Traveller** is anyone with a referral link (created the first time they open their invite screen) or anyone who joined through a live referral. Travellers with nothing yet are included on purpose, so staff can see who is stalled. A voided referral does not make someone a Traveller.
- **Same figures as the app.** Totals and weekly series reuse the public analytics queries, so the console and the app cannot disagree. Per-row figures follow the person's own invite screen: signups are direct referrals only, while countries reached spans the whole network at any depth.
- **Uncached.** The public endpoint is cached for five minutes. The console reads live, so a correction shows up straight away.
- **Stable paging.** Every sort ends on the user id, so a tie cannot repeat or skip a row between pages.
- **The outer user id is written out in full** (`"users"."id"`). Drizzle prints `users.id` as a bare `"id"` in a single-table select, and inside a subquery over `referrals` that silently binds to the referral's own id. The integration test caught this.

## Left out

- No CSV export, and no per-Traveller drill-down. The existing `/admin/referrals/tree` covers the drill-down, but it is still token-guarded.
- Corrections (void a referral, fix a country) stay on the token-guarded `/admin/referrals` surface.
- Country figures depend on geo resolution being configured. Signups with no country are left out of "countries reached".

## Verified

`admin-referrals.integration.test.ts` runs against a scratch Postgres. The fixture is one small tree: a grandchild in another country, an unverified signup, a voided referral, a Traveller with no activity, a bot click and a voided point. It checks who is listed, every per-row figure, both sort orders, paging with no duplicates, search, and that the weekly series sums to the totals. Typecheck is clean and the unit suite passes (1569 tests).
