# Log every request's body, query and route params

**Date:** 2026-09-08

## What changed

The one-line-per-request summary the API already writes now carries the
request's payload alongside method, path, status and duration:

```json
{"ts":"2026-09-08T13:43:56.386Z","level":"info","message":"request",
 "requestId":"464369f4-…","method":"POST","path":"/orders/:id/claim","status":200,
 "durationMs":1.9,
 "body":{"contactEmail":"reader@example.com","password":"****",
         "accessToken":"****","trackingCode":"K7M2QX4P",
         "lines":[{"bookId":42,"quantity":2}]},
 "query":{"debug":"1","currency":"GBP"},
 "params":{"id":"77"}}
```

Three new fields, each omitted when empty so a plain GET does not gain two
dead `{}` entries:

- `body` — the parsed JSON body.
- `query` — the query string.
- `params` — the matched route parameters (`{"id":"77"}` for `/orders/:id`).

Controlled by `LOG_REQUEST_PAYLOADS`. Left unset it follows `NODE_ENV`: on in
development, off everywhere else. Set it to `true` or `false` to override in
either direction.

## Why

Debugging an endpoint from the logs previously meant knowing what the caller
sent, which the logs did not record — the request logger deliberately did not
read the body. That is fine for an audit trail and useless for "why did this
checkout 400".

## The non-obvious decisions

**Redaction moved from pattern-only to pattern-plus-key.** The scrubber
recognised JWTs and refresh tokens by their *shape*. That stops being enough
the moment bodies are logged: a password is an arbitrary string, an OTP is six
digits, and a guest access token is base64url with nothing to anchor on. So
`lib/log-scrubber` gained `SENSITIVE_KEYS` — a value is redacted because of
the field name it arrived under, matched case-insensitively as a substring
with non-word characters stripped, so one `password` entry covers
`newPassword`, `new_password` and `current-password`. A sensitive key replaces
its whole value without descending, so `{ token: { raw, hash } }` is hidden
entirely rather than leaving both halves in the clear.

It lives in the scrubber rather than in the request logger on purpose: the
logger runs it over every line from every call site, so no future
`logger.error` can bypass it by accident.

**`code` is deliberately not a sensitive key.** Referral codes, tracking
codes, ISBNs and country codes all live under it, and redacting the field
would blind the logs to most of what the commerce endpoints do. The tracking
code is an identifier, not a credential — it is useless without the order
email — so logging it costs nothing. See `lib/order-identity` for that
distinction.

**Off outside development by default.** The scrubber hides the fields it can
name, but a body is caller-controlled, and the next endpoint to take a secret
under a name nobody added to the list writes it to the log in the clear. In
development that is a bug to fix; in production it is a disclosure sitting in
an aggregator with a retention far longer than anyone's memory of having
switched this on.

**Payloads are capped at 2kb of JSON**, then truncated to a quotable prefix
with the original length appended. A 50kb bulk-import body — the
`express.json` limit — in every line buries the requests either side of it and
costs real money in an ingest-priced aggregator.

**Read at response finish, not at entry.** `req.params` is empty until the
route has been matched, so capturing earlier would log every request with no
params at all.

**Buffers are summarised as `[Buffer N bytes]`.** A Buffer's own enumerable
keys are its byte indices, so walking one turns a raw body into 50,000
numbered fields. The Stripe webhook router mounts before this middleware and
so never reaches it, but the guard is cheap and the failure mode is not.

## Out of scope

- Request and response **headers**. `authorization` and `cookie` are already
  in `SENSITIVE_KEYS`, but nothing logs headers yet.
- **Response bodies.** They would need a `res.write`/`res.end` wrapper and
  would roughly double log volume.
- Per-route opt-outs. The global flag plus key redaction covers the cases we
  have.

## How it was verified

- `src/__tests__/log-scrubber.test.ts` — six new cases covering key-based
  redaction, the nested-under-sensitive-key case, the fields that must survive
  (`trackingCode`, `referralCode`, `contactEmail`), and the Buffer summary.
  Three existing cases were updated: `authorization` and `tokens` are now
  redacted by key rather than by pattern, which is strictly stronger.
- A live Express app driven over real HTTP, confirming the payload fields
  appear with `LOG_REQUEST_PAYLOADS=true`, that `password` and `accessToken`
  are `****` while `trackingCode` and `lines` survive intact, and that the
  fields disappear entirely with the flag off.
- `tsc --noEmit` clean; full suite at 771 passing. The 4 failures in
  `subscription-pricing` and `referral-copy` pre-date this change (confirmed
  by stashing it).
