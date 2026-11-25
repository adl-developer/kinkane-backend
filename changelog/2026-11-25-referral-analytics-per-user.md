# Referral Analytics shows your own figures

## What changed

`GET /api/v1/referrals/analytics` — the Analytics tab of the referral screen —
now returns the signed-in user's own performance instead of campaign-wide
totals. Referrals Sent, Successful Signups, Countries Reached and the weekly
chart all describe the caller.

Campaign-wide figures stay available to staff at
`/admin/console/referrals/analytics`, unchanged.

## Why

The screen showed numbers like "50 Referrals Sent" to every user. That was
the whole campaign's total, but it read as theirs. Only admins should see
the campaign-wide view.

## Shape

The response shape is unchanged, so no client update is needed.

| Figure | Per-user meaning |
|---|---|
| `totals.sent`, `weekly[].sent` | Invites and shares the caller sent |
| `totals.clicks` | Unique, non-bot taps on any of the caller's links |
| `totals.signups` / `successful`, `weekly[].converted` / `cumulative` | People who signed up directly under the caller |
| `totals.countries` / `continents` | Countries reached by the caller's whole network |
| `topReferrers` | Unchanged: campaign-wide public leaderboard |

## Decisions

- **Auth is optional, not required.** With a valid Bearer token the figures
  are per-user. With no token, or an invalid one, the endpoint still returns
  campaign-wide totals so a client that doesn't send a token keeps working.
  Once every client sends the token, making it required is a one-line route
  change.
- **Countries count the whole network**, matching `/referrals/me/stats`, so
  the two screens can't show different "Countries Reached" figures.
- **Week numbers stay anchored to the campaign start**, so "Wk 3" means the
  same dates for every user.
- **The per-user view isn't cached.** The queries are indexed single-user
  reads, and someone who has just shared a link expects Sent to go up
  straight away. The anonymous campaign view keeps its 5-minute cache.
- **Clicks count all of the caller's codes**, including rotated ones, because
  links that carry an old slug still work.

## Out of scope

- Making auth required: that waits on the client sending the token.
- Changing `topReferrers`.

## Verification

- An integration test in `admin-referrals.integration.test.ts` checks a
  referrer's sent, clicks, signups, successful, conversion rate, network
  countries and weekly totals, and checks that a non-participant sees all
  zeros. It passed against a scratch Postgres.
- Typecheck is clean.
