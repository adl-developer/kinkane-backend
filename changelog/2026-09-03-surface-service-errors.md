# Surface the real reason when a request can't proceed, instead of a blank 500

**Date:** 2026-09-03

## What changed

Services in this codebase signal expected failures by throwing an Error with a
`statusCode` (and usually a `code`) attached — the auth middleware already
honours this. But the shared route wrapper (`wrapHttp`) and the global error
handler only ever surfaced *4xx*. Anything tagged 5xx was flattened to a generic
`{"error":"Internal server error"}`.

That hid a whole class of expected, actionable failures behind a message that
reads like a site fault:

- Stripe not configured → `503 "Payments are not available right now"`
- No exchange rate for a currency → `503 "No exchange rate configured for …"`
- A parcel too heavy for any service → `503` from the shipping quote
- Stripe returning no checkout URL → `502`

A buyer told "this basket is too heavy" can act on it; a bare 500 just looks
broken, and support can't tell the two apart either.

## The fix

`wrapHttp` and the global handler now honour **any** error that carries a
`statusCode`, returning its curated message and `code` — 5xx included. Only an
error with *no* `statusCode` is treated as unexpected: it still gets the generic
500, keeps its stack trace in the logs, and is reported to Sentry.

A surfaced 5xx is logged at `warn` (with its status, code and message) so
operators still see it, but it is **not** sent to Sentry — these are expected
outcomes, not bugs, and paging on them is noise.

## Why it's safe to show the message

Only code we control attaches a `statusCode`, and it only does so to errors
whose message is already written to be shown to a customer. Untagged errors —
database failures, unexpected exceptions — carry no `statusCode` and so keep the
generic message; their detail never reaches the client.

## Verified

Type-check passes. The commerce and shipping suites pass; the checkout failure
this un-masks is covered by the companion heavy-basket change.
