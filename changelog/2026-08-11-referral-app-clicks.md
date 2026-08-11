# Referral clicks from inside the app

**Date:** 2026-08-11

## What changed

New endpoint, `POST /api/v1/referrals/clicks`, plus a mobile integration
checklist for the whole referral flow.

## Why it exists

When iOS or Android opens the app from a universal/app link, **no HTTP request
is made.** The domain-association file was fetched at install time, so the OS
matches the path locally and hands the URL straight to the app. The `/r/...`
handler — the thing that records clicks — never runs.

Left alone, `clicks` would quietly stop meaning "people who tapped the link" and
start meaning "people who tapped it *without the app installed*", getting worse
as installs grow. Nothing would look broken: signups still attribute correctly
through the code the app carries, so a referrer whose friends all have the app
would show 0 clicks and 5 signups. That reads as a conversion miracle rather than
a measurement gap, which is the kind of wrong number that survives a long time.

## The endpoint

```
POST /api/v1/referrals/clicks
{ "code": "K7M3QP9XVT", "channel": "app" }
→ 202 { "ok": true }
```

Unauthenticated by design — the tap happens before there is an account, which is
the entire point of a referral. Rate limited to 120 per 15 minutes, matching the
`/r` redirect, since it is the same event arriving by a different route.

It writes exactly the row the redirect would have, including IP hash, user agent,
resolved country and the `is_bot` flag, so app-reported clicks are deduplicated
and filtered on the same terms as web ones.

**It always returns 202**, whether or not the code resolved. Reporting "unknown
code" would make it an oracle for testing which codes exist — the same reason the
redirect sends unknown codes to the homepage rather than 404ing. The body is
`{ ok: true }` rather than `{ recorded: true }`, deliberately: the latter would be
a claim the response cannot honestly make for a code that didn't resolve.

## Mobile checklist

[mobile-integration.md](mobile-integration.md) gains a referral section covering
the full flow: registering the link patterns, the two domain-association files
and where they must be hosted, reporting the tap, carrying the code to signup via
either the direct body field or the guest session, and the "Have an invite code?"
field.

It spells out one consequence that is easy to underrate: a code that never
reaches signup does not cost one referral, it makes that user a **tree root**. The
referrer loses every downstream referral from that branch permanently, second
degree points never arrive, and any circuit that would have closed through it
never fires — with nothing anywhere reporting that it should have.

## Still blocking, and not fixable from this repo

The `/r/*` rewrite and both `.well-known` files have to be served from
`kinkane.app`. Until then, referral links do not work in production at all. See
[referral-link-routing.md](referral-link-routing.md).

## How it was verified

Exercised end to end against the real app, the local Postgres and the local
Redis: the Express app was booted on an ephemeral port and called over HTTP with
no `Authorization` header.

- A real code returned **202** and wrote one row, `is_bot=false`, IP recorded.
- An unknown code returned an **identical 202** with no row written — confirming
  there is no code-existence oracle.
- A malformed code returned **400**.
- A WhatsApp preview user agent wrote a row flagged `is_bot=true`.
- The deduplicated, non-bot count over those two rows came back as **1**.

All fixture rows, the temporary user and code were deleted afterwards, and the
`is_bot` column (which only exists in the not-yet-applied migration 0035) was
added for the test and dropped again, so the local database is exactly as it was.

192 tests, 189 passing — the 3 failures in `subscription-pricing.test.ts` are
pre-existing on `main` and unrelated.
