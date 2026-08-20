# Guest baskets live on the client; guests can check out and track orders

## What changed

Before signing in, a shopper's basket is now held entirely by the client and
**nothing is written to our database**. Two new pieces support that:

- `POST /api/v1/cart/price` — prices a basket the client is holding. Stateless:
  no cart row, no token, no record of a visitor who never signs up.
- `POST /api/v1/cart/checkout` now accepts `lines` in the body, so a guest can
  buy without an account. A signed-in buyer still checks out the cart we store.

After payment, a guest gets back an order `reference` and a one-time
`accessToken`, and two new endpoints use them:

- `POST /api/v1/orders/lookup` — "Track My Order", unauthenticated.
- `POST /api/v1/orders/claim` — attaches a guest order to a new account.

## Why

The Figma checkout flow has no sign-in step and only offers account creation
*after* payment, so the shop has to work for people who never log in.

The first implementation stored guest carts server-side behind a hashed token.
That worked, but it meant an unauthenticated endpoint wrote a row on every
anonymous visit (including a bare `GET /cart`), and it introduced a bearer
credential with a full lifecycle to mint, hash, expire and sweep. Moving the
pre-login basket to the client removes all of it — and removes the need for
cart-merge logic on login, since the client simply replays its lines once it
has an auth token.

## Data and API shape

- `orders.user_id` and `payments.user_id` are now nullable — a guest order has
  no account behind it. `orders.contact_email` stays `NOT NULL` and is the
  identity that always exists.
- `orders.reference` (`ORD-7K2M9QX4`) is crypto-random, not sequential, so the
  order book cannot be enumerated. Backfilled for existing rows.
- `orders.guest_access_token_hash` holds SHA-256 of the token handed to the
  buyer at checkout. Cleared on claim, which makes claiming single-use.
- `orders.cart_id` records which cart an order came from; null for guests.
- Tracking columns (`carrier`, `tracking_number`, `tracking_url`,
  `dispatched_at`, `delivered_at`) and a `delivered` order status.
- `book_promotions` — our own markdowns, read by `availabilityService`.
- `carts` is unchanged: still one active cart per user, `user_id NOT NULL`.

## Non-obvious decisions

**The reference is an identifier, not a credential.** It is printed on receipts
and pasted into support tickets, so access is gated on the 256-bit token
instead. Both are required, and an unknown reference and a wrong token return
an identical 404 so the endpoint cannot be used to test which orders exist.

**Claiming is one conditional UPDATE**, not read-then-write. Two tabs racing
would both pass a separate "is it unclaimed?" read, and the second write would
silently retag an order that already had an owner.

**Prices are never read from the request.** A guest's basket supplies book ids
and quantities only; every price, sale price and stock figure is computed from
our own data. This is what makes an unauthenticated pricing endpoint safe.

**`availableQuantity` is capped at what was asked for.** The pricing endpoint is
public, and Gardners' inventory depth is not ours to publish. "You can have 2 of
the 5 you wanted" tells the buyer everything without revealing the shelf.

**Sale prices resolve inside `availabilityService.check()`** — the single gate
both cart and checkout already pass through — so the shelf price, the basket
price and the amount Stripe charges cannot diverge. The customer always pays the
lower of sale price and RRP.

## Explicitly out of scope

- **Gardners promotion data is not used for sale prices.** `GARDPROM13`'s
  `discount_percent` matches the *trade* discount on `gardners_stock` and its
  `price` equals RRP on 20,969 of 20,973 matched rows — it describes our margin,
  not a customer reduction. `book_promotions` ships empty; no prices are set.
- No re-issue path for a lost order access token. Only the hash is stored, so a
  lost token cannot be recovered — the client must persist it and the
  confirmation email should carry a tracking link.
- Guest access to an order does not expire yet.
- Wishlist, facets, author pages, cart recommendations, and making
  `GET /books/:id/similar` public all remain outstanding.

## How it was verified

`tsc --noEmit` clean; 264 unit tests pass (3 pre-existing failures in
`subscription-pricing.test.ts` are unrelated). New tests cover order-reference
shape and uniformity, access-token entropy, constant-time hash comparison, and
the status-bucket mapping.

The migration was applied against a development database inside a transaction
and rolled back: references backfill uniquely, the unique constraint rejects
duplicates, `carts` keeps `user_id NOT NULL` with no guest columns, and the
`book_promotions` constraints reject non-positive prices and backwards windows.
An expired promotion alongside a live one correctly resolves to the live price.
