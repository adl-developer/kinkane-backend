# Send guest receipts to the address the buyer actually typed

**Date:** 2026-09-08

## What changed

A buyer checking out through the web shop now has their order recorded against
the email address they entered, instead of the placeholder one the shop
invented for them.

Previously those orders were stamped with a
`guest-<uuid>@guest.kinkane.app` address. The confirmation email went there,
the Stripe customer was created there, and the "Track My Order" form expected
it — an address the buyer had never seen and could not receive mail at.

## Why it happened

Two unrelated things were both called "guest".

The web shop requires a Bearer token on every cart and checkout call, so rather
than show a login wall it signs the browser up silently on first add-to-cart,
under a synthetic address (`is_guest` in `db/schema/users`). That browser then
arrives at checkout **authenticated**, so checkout took its signed-in branch:

```
userId !== null  →  contactEmail = user.email   ← the placeholder
                    options.contactEmail discarded
```

The rule it was following — a signed-in buyer's account email wins, and the
request body cannot name its own contact address — is correct, and stays.
Without it, checkout is a way to post someone else's receipt wherever you like.
It simply never anticipated an account whose email is a placeholder. The word
"authoritative" was only ever meant to describe an address its owner chose and
can receive mail at.

## The effects, all silent

1. **Confirmation emails were sent into a void** — `to: order.contactEmail`, a
   domain with no inbox. They queued, sent and bounced.
2. **No tracking credential.** `stashGuestToken` was gated on `userId === null`,
   so these orders skipped it. The buyer got neither the guest block in the
   email nor a claimable order — and a guest account's order history lives
   behind a token in browser storage, so clearing site data took the order with
   it, permanently.
3. **Stripe showed the placeholder.** `ensureStripeCustomer` builds the customer
   from `users.email`, and a session with a `customer` never sets
   `customer_email` — so the buyer's real address appeared nowhere in the
   dashboard.
4. **Order tracking was unusable**, since the code/email pair named an address
   the customer could not know.
5. **The first-order discount keyed per browser**, not per person:
   `contact_email_normalized` was unique to each silently-created account.

## What now happens

The distinction moved off "is `userId` null" and onto a single derived
`isGuestBuyer`, extracted as the pure `resolveBuyerContact` in
`services/commerce/checkout.service`. Three cases:

| Buyer | Contact email | Guest treatment |
|---|---|---|
| No account | typed, required | yes |
| Guest account (`is_guest`) | typed, required | yes |
| Real signed-in buyer | account email; body ignored | no |

`isGuestBuyer` then drives the token stash and the Stripe customer decision, so
these orders get an emailed access token and are filed in Stripe under
`customer_email` rather than a placeholder customer record.

`orders.claim` was widened to match. It required `user_id IS NULL`, which
locked out precisely these buyers — their orders arrive with a `user_id` set,
just to a placeholder account. It now accepts an order that is unowned *or*
owned by an `is_guest` account, still as one conditional UPDATE. Single-use
survives: a successful claim moves the row to a real account, which fails the
predicate the second time.

## The non-obvious decisions

**A missing email is now a 400, not a fallback.** The fallback *was* the bug —
it always succeeded, and every order it produced was unreachable. `EMAIL_REQUIRED`
is the code the client already handles on the no-account path.

**The order still records `userId`.** `isGuestBuyer` governs how the buyer is
reached and re-found, not who the order belongs to, so the account's own order
history keeps working while that browser holds its token.

**The decision reads the `is_guest` column, never the address.** The
`@guest.kinkane.app` domain is a convention the frontend owns; a second query
pattern-matching it here would let a frontend rename break checkout. There is a
test for this.

**The basket still keys on `userId`.** A guest account has a real stored cart,
so `loadBasket` is unchanged — the account is a placeholder identity, not a
placeholder session.

## Out of scope

- **Existing orders are not backfilled.** Orders already written with a
  placeholder address keep it; their real address was never stored anywhere, so
  there is nothing to recover it from. Finding them is
  `WHERE contact_email LIKE '%@guest.kinkane.app'`.
- **Purchase signals** still record against the guest account, which is correct
  — that account is the one whose recommendations should reflect the purchase.
- **Converting a guest account into a real one** at checkout. The order is now
  claimable, which covers the same ground without a second identity flow.

## How it was verified

- `src/__tests__/guest-account-checkout.test.ts` — six cases over
  `resolveBuyerContact`: the typed address wins for a guest account, a missing
  one is refused rather than falling back, the refusal carries
  400/`EMAIL_REQUIRED`, a real signed-in buyer's body is still ignored, no
  account behaves identically to a guest account, and the decision follows
  `is_guest` rather than the address shape.
- `tsc --noEmit` clean; full suite 777 passing. The 4 failures in
  `subscription-pricing` and `referral-copy` pre-date this change.
