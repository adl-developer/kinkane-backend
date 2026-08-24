# 15% off a buyer's first order, applied automatically

## What changed

"15% OFF YOUR FIRST ORDER" runs as a banner on every page of the web shop and
had nothing behind it. It is now real:

- `FIRST_ORDER_DISCOUNT_PERCENT` sets the rate; `0` turns the promotion off.
- `orders.discount_gbp_pence`, `discount_minor` and `discount_reason` record
  what was given and why.
- `orders.contact_email_normalized`, indexed, backs the eligibility check.
- The checkout response carries `discountMinor` and `discountReason`.

Nothing is typed in. A buyer whose email has never paid for anything before
gets the reduction on the goods, automatically, at checkout.

## Why

The banner was a promise the server could not keep. The choice between an
automatic discount and a promo code was made deliberately in favour of
automatic, because the checkout design has no field to type a code into.

## Non-obvious decisions

**Automatic, not a code.** The cost is that a second promotion needs the codes
table this skipped. `discount_reason` is a string rather than a boolean so that
day is additive rather than a migration of every existing row.

**Eligibility keys on the email, not the user id.** The shop sells to guests, so
an account-scoped check is bypassed by simply not signing in. The signed-in user
id is checked *as well*, so changing your email does not earn a second first
order.

**`paid_at IS NOT NULL`, not a status list.** An abandoned checkout leaves a
`pending_payment` row behind. Counting those would deny the discount to someone
who has never bought anything — the worst direction to be wrong in, because they
are told they had a first order they never received.

**The abuse guard is a speed bump, not a wall.** `+tags` are stripped for every
domain and dots for the two Google ones, so the trick that costs nothing to
perform stops working. A second real mailbox still earns a second discount, and
that is accepted. The normaliser is documented as unsafe for identity — never
authenticate, deduplicate accounts, or merge order history on it.

**Shipping is quoted pre-discount.** Otherwise a £40 basket with a free-shipping
threshold at £40 discounts to £34 and gets charged delivery: a promotion that
leaves the buyer worse off. Tax, by contrast, is charged on the discounted
amount, because tax is owed on what was actually paid.

**Stripe gets a one-off `amount_off` coupon, not a reusable `percent_off` one.**
Percent-off would have Stripe recompute the reduction from its own line items
and round it its own way, which can disagree with the stored `total_minor` by a
penny or two. This codebase's money design rests on the charged amount provably
equalling the stored amount, so the coupon carries the exact integer already
committed to the order row. Shipping is a shipping option rather than a line
item, so it is untouched by the coupon — which matches the quote.

**Identity is now resolved before the price.** The quote used to be computed
before the contact email; eligibility depends on the email, so the two steps
swapped order.

**The migration is hand-edited.** `contact_email_normalized` is NOT NULL and
drizzle-kit emits a bare `ADD COLUMN ... NOT NULL`, which fails outright on a
table that already has rows. It now adds the column nullable, backfills with SQL
mirroring `normalizeEmailForPromotions`, then applies the constraint. **The two
normalisers have to stay in step**: a row backfilled differently from how new
rows are written is a buyer who silently qualifies for a second first order.

## Explicitly out of scope

**A discount line in the basket.** `POST /cart/price` and `GET /cart` never ask
for an email and eligibility depends on one. Adding an email parameter would
turn the basket into an oracle for "has this address ordered here before", which
is not a question a public endpoint should answer about anybody. The reduction
appears once, at checkout — which also means **the checkout design needs a
discount line it does not currently have**.

**Keeping the banner and the rate in step.** The banner text lives with the
storefront and the rate lives in this config. Turning one off without the other
leaves the site advertising a discount it no longer gives.

**Promo codes, stacking, expiry, per-campaign reporting.** None of it exists.
`discount_reason` is the seam it would hang off.

## Verification

`npx tsc --noEmit` clean. `src/__tests__/first-order-discount.test.ts` covers
the arithmetic — goods only, components reconciling to the total the client is
shown, the free-shipping threshold unaffected, tax on the discounted base, and a
discount that rounds away to nothing claiming no reason — plus the email
normaliser, including that a local part which is only a tag is left alone rather
than collapsing to `@domain` and colliding with every other such address.

Full suite: 322 passing. The three failures in `subscription-pricing.test.ts`
pre-date this work and fail identically on a clean tree.

**Not run against a database.** The migration has not been applied anywhere, and
the eligibility query is unexercised outside of types.
