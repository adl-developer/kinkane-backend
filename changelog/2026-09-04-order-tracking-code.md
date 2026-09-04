# Add a short tracking code so customers can find an order without a token

**Date:** 2026-09-04

## What changed

Every order now carries an eight-character code — `7K2M9QX4` — that a customer
enters on "Track My Order" together with the email address they ordered with.
It goes in the confirmation email, comes back on every order response, and
drives a new public endpoint:

```
POST /api/v1/orders/track   { code, email }
```

The problem it solves is that the only existing way to reach an order without
an account was `POST /orders/lookup`, which takes the order reference *and* a
43-character base64url access token. That token is fine in a link and hopeless
to a customer who has lost the email and is reading a code off their phone.
Signed-in customers get the code too — a code read off a printed slip should
work regardless of which account the order hangs off, and `GET /orders` is
still there for people who would rather just log in.

This is **our** code, not the carrier's. It exists from the moment the order is
written, so it tracks an order that has not shipped yet; `trackingNumber` is
still Royal Mail's, still arrives from a Gardners `.HDD` dispatch file, and
still stays null until the parcel moves.

## Data model

`orders.tracking_code`, varchar(16), not null, unique. Generated at checkout
from `generateTrackingCode()` — Crockford base32 with I, L, O and U removed, the
same alphabet the order reference already uses, because this is a string that
exists to be read aloud and retyped.

Migration: [0059_cloudy_jetstream.sql](../drizzle/0059_cloudy_jetstream.sql). Written by
hand rather than left as drizzle-kit generated it: `ADD COLUMN ... NOT NULL
UNIQUE` cannot run against a table that already has orders in it, so the column
arrives nullable, a PL/pgSQL loop gives every existing order a unique code, and
only then is it constrained.

## Non-obvious decisions

- **The code is an identifier, not a credential, and the email is what makes
  that safe.** Eight characters is ~1.1e12 codes — plenty against accidental
  collision, not enough to be a password against someone patient. Pairing it
  with the contact email means a guessed code reveals nothing, which is what
  makes a code this short defensible at all. There is deliberately no
  code-only read path, and the rate limiter is tight for the same reason.
- **The email is compared with a plain case-insensitive match, *not* with
  `normalizeEmailForPromotions`.** That normaliser collapses `+tags` and gmail
  dots so two addresses can be treated as one person for a discount — exactly
  the property that must not exist here, where `rachel+anything@gmail.com`
  would otherwise open Rachel's order. Its own docstring says never to
  authenticate on it; `order-tracking-lookup.test.ts` locks that in.
- **The code is normalised before it is validated, not after.** A customer
  retyping `7k2m-9qx4` has typed a valid code. Validating the raw string would
  mean either rejecting them or writing a pattern loose enough to also accept
  `7-------` and send it to the database. Normalising first makes "exactly
  eight characters from the alphabet" the only rule.
- **`OrderConfirmedPayload.trackingCode` used to mean the guest access token**
  and now means this code; the token moved to `accessToken`. Left as-is, the
  next person to touch that template would have printed a 43-character
  credential under a heading promising a short code, or worse, the reverse.
- **A tracking code collision retries the insert rather than failing the
  checkout.** `violatedConstraint()` was added so the existing catch — which
  reads a unique violation as "the first-order discount was already claimed,
  re-price without it" — does not swallow a collision and silently drop the
  buyer's discount over an unrelated constraint.

## Out of scope

- No "Track My Order" UI: this repo is the API. The Postman commerce collection
  carries the new request, with the code-plus-email requirement spelled out.
- `POST /orders/lookup` and `POST /orders/claim` are untouched. Claiming a guest
  order into an account still requires the long token, because that one really
  is a credential.

## Testing done

- `order-tracking-lookup.test.ts` (new, 6 tests) — the code/email pairing
  against a database double: right code with a wrong email returns null, a
  `+tag` and a dotted gmail are both rejected, an unknown code and a wrong email
  are indistinguishable, and the typed code is normalised before the query.
- `order-identity.test.ts` — generation matches the endpoint's pattern, excludes
  I/L/O/U, carries no `ORD-` prefix, does not repeat over 2000 draws; plus the
  validation rule, including that `7-------` is rejected.
- `order-confirmed-email.test.ts` — the short code is printed for everyone in
  both HTML and text, the email pairing is stated where the code is shown, and
  the guest access token is still guest-only and still never inside a URL.
- Full suite: 710 tests, 705 passing. The five failures are pre-existing and
  environmental (`subscription-pricing` and `referral-copy` read local Stripe
  and campaign env vars); none touch order code.
- `tsc --noEmit` clean.
- Migration has not yet been run against a live database.
