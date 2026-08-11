# Referral clicks now count people, not hits

**Date:** 2026-08-11

## What changed

The `clicks` figure on `GET /api/v1/referrals/me/stats` used to be a raw row
count of every request to a referral link. It now counts **distinct people**,
and excludes link-preview fetchers.

Two things were inflating it:

**Repeat taps.** One person opening the link five times was five clicks.

**Link previews.** WhatsApp, iMessage, Slack, Telegram and the rest fetch a URL
server-side to build the preview card — and in a group chat, potentially once per
recipient. Those requests hit the redirect endpoint exactly as a human tap does.
A link shared into one busy group could report dozens of clicks nobody made.

## How it works

`referral_clicks` gains an `is_bot` column, set at insert from the user agent by
`isBotUserAgent` ([user-agent.ts](../src/lib/user-agent.ts)). Preview traffic is
**flagged, not dropped** — the rows stay in the table, so "was the link even
delivered?" is still answerable, while the number a user sees is people.

The count is then:

```sql
count(distinct (coalesce(ip_hash, id::text), coalesce(user_agent, '')))
  where is_bot = false
```

**Deduped on (hashed IP, user agent), not IP alone.** A household, office or
mobile carrier behind one NAT would otherwise collapse to a single click no
matter how many people followed the link, and shared egress IPs are the norm in
much of the world. The pair is not a true identity — the same person on wifi and
then mobile data counts twice, and there is no cookie available on a redirect
that has to stay anonymous — but it is much closer than either extreme.

The `COALESCE` on `ip_hash` matters: without it every row with no recorded IP
shares a `NULL` and the whole set collapses to one.

## The Cubot problem

The generic bot pattern requires a non-letter either side of the match:

```js
/(^|[^a-z])(bot|crawler|spider|scraper|preview|fetcher)([^a-z]|$)/
```

A bare `includes('bot')` would flag every visitor on a **Cubot** handset — a
budget Android brand with real market share in exactly the regions this
competition is meant to reach. Their user agent contains `CUBOT`, and matching
inside it would have silently zeroed those users' clicks with no error anywhere.
There is a test pinning this.

A **missing** user agent is deliberately treated as a person, not a bot. Privacy
browsers and some in-app webviews strip the header, and discarding those clicks
is a worse error than counting a few scripts — there is no prize money to defend.

## Frontend routing — still outstanding

[docs/referral-link-routing.md](referral-link-routing.md) documents a gap this
work exposed but does not fix: links are built from `APP_URL`
(`https://kinkane.app/r/CODE/name`), but the handler that records clicks runs on
the **API** server, deployed separately. In production the link lands on the
frontend, which has no `/r` route, so nothing is recorded.

It doesn't show up locally, where `APP_URL=http://localhost:3000` *is* the API —
which is exactly why it is easy to miss. Signups still attribute (the code
travels in the signup body), so the symptom is `clicks` stuck at 0 while
`signups` climbs.

The fix is a one-line rewrite in the frontend project, given for Next.js, Vercel
and Netlify in that doc. **It has to be applied there; nothing in this repo can
do it.**

## Correction to earlier notes

Previous write-ups referred to `GET /admin/referrals/funnel`. **That endpoint
does not exist.** The admin surface is `/admin/referrals/tree`,
`/admin/referrals/leaderboard`, `POST /admin/referrals/:id/void` and
`PATCH /admin/users/:id/country`. Click/signup conversion is currently only
available by querying `referral_clicks` and `referrals` directly.

## How it was verified

Six unit tests on the user-agent classifier: real preview-fetcher strings from
WhatsApp, Slack, Telegram, Twitter, Discord, LinkedIn and Skype; crawlers and
scripted clients; four ordinary browser strings; the Cubot case; and the
missing-user-agent case.

The dedupe SQL was run against a real Postgres inside a rolled-back transaction,
with nine fixture rows: three taps from one person, one from the same IP on a
second device, one from a different person, two WhatsApp preview fetches, and two
clicks with no recorded IP. It reported **5**, which is correct — repeats
collapsed, previews excluded, unknown-IP rows kept distinct. The database was
left unchanged.

192 tests, 189 passing. The 3 failures in `subscription-pricing.test.ts` are
pre-existing on `main` and unrelated.
