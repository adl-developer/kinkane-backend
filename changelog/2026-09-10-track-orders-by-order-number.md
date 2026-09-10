# Track an order with the order number, not a separate tracking code

**Date:** 2026-09-10

## What changed

"Track My Order" now takes the order number a customer already has —
`ORD-7K2M9QX4` — plus the email address they ordered with:

```
POST /api/v1/orders/track   { reference, email }
```

It used to take `code`: a separate eight-character string, generated at
checkout, printed large in the confirmation email, and sitting immediately
below an order number that looked almost exactly like it. `ORD-7K2M9QX4` and
`7K2M9QX4` are the same characters, and the only question the pair ever
produced was which one went in the box. There is now one identifier, and it is
the one printed on the receipt, quoted in support and searched for in an inbox.

The security model is unchanged: the string a customer types is an identifier,
never a credential, and the contact email is what makes looking up on it safe.
An unknown order number and a mismatched email are still the same `404`, and
the rate limit is still 10 per 15 minutes per IP.

## The data model did not change

`orders.tracking_code` is still there, still `NOT NULL UNIQUE`, and checkout
still generates one. Nothing customer-facing reads it: no endpoint accepts it,
no email prints it, and it is marked deprecated in the OpenAPI spec. It stays
so that orders written before and after this change look the same in support
and in history, and so no migration has to rewrite live order rows.

`trackingNumber` is untouched. That is the carrier's, arrives from a Gardners
dispatch file, and is still null until a parcel moves.

## Non-obvious decisions

- **The `ORD-` prefix is optional on input.** `normalizeReference` uppercases,
  strips spaces and dashes, drops a leading `ORD`, and re-forms the canonical
  string. The prefix is on every order, so it carries no information and is the
  first thing a customer leaves out. Stripping it cannot eat part of a real
  reference: `O` is absent from the alphabet, so no generated body can begin
  with those letters, and `order-identity.test.ts` locks that in against
  someone later "tidying" the alphabet back to full base32.
- **Normalise first, then validate** — the same rule the old code lookup used,
  for the same reason. A pattern loose enough to allow the dash in
  `ord-7k2m-9qx4` would also wave `ORD-7-------` through to a database lookup.
- **Old codes were cut off rather than kept working in parallel.** Accepting
  either string would have preserved exactly the ambiguity this removes, in the
  code and in anything written about it. Anyone holding a confirmation email
  from before today has the order number in the same email, in the subject
  line.
- **`POST /orders/lookup` is untouched** and still takes the reference plus the
  43-character access token. It is what the confirmation screen calls while
  your own code still holds the token, and it proves ownership with 256 bits
  rather than an email address. `POST /orders/claim` still requires the token
  too, because it is a write that transfers ownership permanently.
- **A reference collision now retries the insert** instead of failing the
  checkout. That branch already existed for the tracking code and named only
  its constraint, so an unlucky reference fell through to the first-order
  discount handler and out as an error. The reference is the string a customer
  now depends on, and both are the same ~1.1e12 lottery.
- **The confirmation email now shows the order number twice** — the subject
  line and the large block. That repetition is deliberate: the block is what a
  customer comes back to the email to find.

## Out of scope

- No "Track My Order" UI: this repo is the API. The Postman commerce collection
  carries the new request body.
- No migration. The tracking code column and its data are left exactly as they
  are.

## Testing done

- `order-tracking-lookup.test.ts` — the reference/email pairing against a
  database double: a right order number with a wrong email returns null, a
  `+tag` and a dotted gmail are both rejected, an unknown reference and a wrong
  email are indistinguishable, the typed string is normalised before the query,
  and a customer who omits `ORD-` still finds their order.
- `order-identity.test.ts` — `normalizeReference` against what customers
  actually type, and the round trip that proves prefix-stripping cannot corrupt
  a real reference over 500 generated draws.
- `order-confirmed-email.test.ts` — the order number is printed for everyone in
  both HTML and text, the email pairing is stated where it is shown, no bare
  eight-character code appears anywhere, and the guest access token is still
  never in the email.
- `log-scrubber.test.ts` — an order reference in a logged body is still legible
  rather than redacted.
- Full suite: 782 tests, 778 passing. The four failures are pre-existing and
  environmental (`subscription-pricing` and `referral-copy` read local Stripe
  and campaign env vars); none touch order code.
- `tsc --noEmit` clean.
