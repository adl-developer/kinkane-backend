# E-commerce: cart, checkout & bestsellers — plan

Status: **implemented** on `feat/ecommerce-cart-checkout`, 2026-08-10, branched
from `main`. Decisions confirmed 2026-08-10 — see [Decisions](#decisions). See
`changelog/2026-08-10-ecommerce-cart-checkout.md` for what actually shipped.

Three things diverged from this document during the build:

- **Country resolution delegates to `geoService`.** It was briefly
  self-contained: `feat/referral-competition` was unmerged when this was built,
  so commerce read `GEO_COUNTRY_HEADER` itself. That branch has since landed
  (PR #47), and the predicted duplicate env definition was collapsed onto
  main's — which is the better one, since it also does a MaxMind lookup.
  `resolveRequestCountry()` in `services/commerce/pricing.ts` is now a thin
  async wrapper over `geoService.resolveFromRequest`.

  The distinction that matters: referrals resolve country **once at signup and
  freeze it** on the user row, so a travelling user cannot shift continent
  mid-competition. Currency resolves **live, per request** — someone who signed
  up in Lagos and now lives in Berlin should see EUR.
- **Option (a) won on address collection** — the destination country is asked
  for by our own API before the Stripe session exists, and Stripe's address
  collection is then locked to that country. See the checkout flow below.
- **Market restrictions fail closed for restricted titles.** Not in the original
  plan, which only said "enforce at add-to-cart". Gardners' region codes do not
  map to ISO-3166, so the mapping is operator-supplied and ships empty; while it
  is empty, titles that carry restriction rows are blocked rather than sold on a
  guess.

Still outstanding: the `requirePlus` on `like` (see decision 1).

## What this is

Turn Kinkané from a discovery/social app into one you can actually buy books
from. Four pieces, in dependency order:

1. **Likes** — already built. Nothing to do (see below).
2. **Cart** — add books, change quantities, fetch the current cart.
3. **Checkout** — Stripe one-time payment, then hand the paid order to Gardners
   for dropship fulfilment.
4. **Bestsellers** — rank books by how many copies were actually bought.

## What already exists (and what that buys us)

This is not a greenfield build. Four of the five hard parts are already in the
repo:

| Piece | Where | State |
| --- | --- | --- |
| Likes / favourites | `user_books.liked` + `POST\|DELETE /v1/user-books/:bookId/like` | **Done.** Reuse as-is |
| Stripe client, webhook route, idempotency | `src/lib/stripe.ts`, `src/services/subscriptions/`, `stripe_webhook_events` | Done for *subscriptions*; needs a payment-mode branch |
| Fulfilment (order → Gardners → ack) | `src/services/gardners-dropship/` | Done, but admin-only and `testing: true` by default |
| Live price + stock per ISBN | `gardners_stock` (`rrp_gbp`, `discount_percent`, `stock_qty`, `report_code`) | Done, fed daily (Inventory) + hourly (Avail13) |
| Purchase signal | `user_interactions` type `'purchase'`, weight 6 | Declared, **nothing writes it yet** |

### Likes: nothing to build

`POST /v1/user-books/:bookId/like` and `DELETE .../like` already exist and are
idempotent. A like sets `user_books.liked` (creating the shelf row if needed),
writes a `like` interaction, and feeds trending. The only change worth
considering is the **gating**: `like` currently sits behind `requirePlus` while
`unlike` is free (the "retain, read-only" downgrade). If buying is open to free
users, liking probably should be too — see Open question 1.

### Pricing: sell at RRP, `discount_percent` is our margin

`gardners_stock.rrp_gbp` is the recommended retail price; `discount_percent` is
the trade discount **we** get from Gardners. So the customer price is RRP and the
margin is the discount. `book_prices` (the ONIX table) is *not* the right source
— it is edition metadata, multi-currency, and only covers the ~55% of the
catalogue that ONIX reaches.

A book is buyable when it has a `gardners_stock` row with `stock_qty > 0` and a
non-null `rrp_gbp`, and its `report_code` is not a dead code (`O/P`, `CNC`, `NYP`
— the exact deny-list needs confirming against the Gardners code list).

## Money: two currencies, one source of truth

This is the single most invasive consequence of the decisions below, so it comes
before the schema.

**Every price in the system originates as GBP pence** — that is what Gardners
quotes, what we pay them, and what the EDI wire format already carries. But the
customer is shown and charged in their **presentment currency**, defaulting to
USD. So every order carries both:

- `base_currency` = `'GBP'`, and `*_gbp_pence` columns — the supplier-side truth,
  what fulfilment and margin reporting read.
- `presentment_currency` (`'USD'` by default) and `*_minor` columns — what Stripe
  charged and what the receipt says.
- `fx_rate` and `fx_captured_at` — **pinned onto the order at checkout**, so the
  amount displayed is provably the amount charged, and a rate change tomorrow
  can't retroactively make an old order look mispriced.

### Resolving the presentment currency

Location comes from the same signal `geo.service.ts` already uses (the CDN
country header, MaxMind fallback). One important difference: geo.service resolves
country **once at signup and freezes it on the user row**, deliberately, so a
travelling user can't shift continent mid-competition. Currency must *not* reuse
that frozen value — someone who signed up in Lagos and now lives in Berlin should
see EUR. So currency resolves from the **live** request, per request, with the
frozen `users.country_code` only as a fallback when the header is absent.

Resolution order: explicit `?currency=` override → live geo header → frozen
`users.country_code` → `USD`.

Mapping and rates are env-driven, matching the shipping/VAT decisions:

```
SUPPORTED_CURRENCIES=USD,GBP,EUR,NGN,CAD,AUD
DEFAULT_CURRENCY=USD
CURRENCY_BY_COUNTRY=GB:GBP,IE:EUR,DE:EUR,FR:EUR,NG:NGN,CA:CAD,AU:AUD
FX_RATES_FROM_GBP=USD:1.27,EUR:1.17,NGN:1950,CAD:1.74,AUD:1.93
FX_BUFFER_PERCENT=3
```

Three things this has to get right:

- **A static env rate table drifts.** That is an accepted trade for launch — no
  external dependency, no new failure mode in the checkout path — but it needs
  `FX_BUFFER_PERCENT` padding the rate so a few weeks of drift eats the buffer
  rather than the margin, and it needs a calendar reminder to re-check. If FX
  ever moves enough to matter, swap the env table for a daily-cached rates feed
  behind the same interface; nothing else changes.
- **Zero-decimal currencies.** JPY, KRW and friends have no minor unit and Stripe
  rejects amounts that assume one. The minor-unit exponent must come from a
  lookup, not from a hardcoded `× 100`. Keeping `SUPPORTED_CURRENCIES` short at
  launch sidesteps this, but the helper should be right from the start.
- **Rounding is always up.** Convert, apply the buffer, then round *up* to a
  sensible increment. Rounding down loses money on every single line.

Charging in the presentment currency (rather than charging GBP and letting the
card issuer convert) is the right call because Stripe supports it natively and it
removes the surprise FX fee on the customer's statement — but note it means
Stripe settles in mixed currencies, which is a finance/reconciliation
consideration, not an engineering one.

## Data model

Four new tables. Names are proposals.

### `carts`

One row per user per open cart. `status`: `active | converted | abandoned`.
Partial unique index on `user_id WHERE status = 'active'` guarantees exactly one
open cart per user — that constraint is what makes "get or create the cart" a
safe upsert instead of a race.

Columns: `id`, `user_id` (FK cascade), `status`, `created_at`, `updated_at`.

Deliberately **no currency column**. A cart is a list of intentions, not a
quotation — currency is resolved from the request every time the cart is read, so
the same cart shown to the same person after a flight prices correctly. Currency
first becomes durable data at checkout, on the order.

### `cart_items`

Columns: `id`, `cart_id` (FK cascade), `book_id` (FK), `isbn13` (denormalised —
the Gardners side is ISBN-keyed and books can be re-slipped), `quantity`,
`unit_price_gbp_pence` (**snapshot at add time**), `price_captured_at`,
`created_at`, `updated_at`. Unique on `(cart_id, book_id)` so "add again" is an
increment, not a duplicate row.

The snapshot is for display honesty, not for charging. Prices move daily with the
Inventory feed. **Checkout always re-reads live price and stock and never trusts
the stored snapshot** — if either moved, the checkout call returns 409 with the
changed lines so the client can show "the price of X changed to £Y, continue?".
Storing the snapshot is what makes that diff possible at all.

### `orders`

Created *before* Stripe redirect, in `pending_payment`. Status ladder:

```
pending_payment → paid → submitted_to_supplier → acknowledged → dispatched
                ↘ payment_failed / expired      ↘ supplier_rejected
                                                 refunded
```

Columns: `id`, `user_id`, `status`, `stripe_checkout_session_id` (unique),
`stripe_payment_intent_id`, `shipping_*` address fields, `shipping_country_code`,
`contact_email`, `gardners_dropship_order_id` (nullable FK to the existing
table), `paid_at`, `created_at`, `updated_at`.

Money columns, per the two-currency model above:

- Supplier side: `subtotal_gbp_pence`, `shipping_gbp_pence`, `tax_gbp_pence`,
  `total_gbp_pence`.
- Customer side: `presentment_currency`, `subtotal_minor`, `shipping_minor`,
  `tax_minor`, `total_minor`.
- Provenance: `fx_rate` (numeric), `fx_captured_at`, `tax_rate_percent`,
  `shipping_rule` (which env rule produced the figure — invaluable when someone
  asks why an order six months ago was charged what it was).

### `order_items`

`id`, `order_id`, `book_id`, `isbn13`, `quantity`, `unit_price_gbp_pence`,
`line_total_gbp_pence`, `unit_price_minor`, `line_total_minor`, plus a
`title`/`author` snapshot so an order receipt still reads correctly after the
catalogue row changes. This table is also the sole source of truth for
bestsellers — which is why bestseller ranking counts `quantity`, never money: it
must not be skewed by which currency the buyer happened to be in.

## API surface

All under `/api/v1`, all `requireAuth`. Guest carts are out of scope for v1
(Open question 2).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/cart` | The user's active cart, hydrated with book + live price/stock, priced in the caller's resolved currency, plus a `priceChanged` / `outOfStock` flag per line. Creates an empty cart lazily |
| `POST` | `/cart/items` | `{ bookId, quantity? }` — adds, or increments if present. Rejects unbuyable books (404 no stock row / 409 out of stock / 409 market-restricted) |
| `PATCH` | `/cart/items/:bookId` | `{ quantity }` — absolute set, not a delta. `quantity: 0` deletes the line. This is the "increase or reduce" endpoint |
| `DELETE` | `/cart/items/:bookId` | Remove a line |
| `DELETE` | `/cart` | Empty the cart |
| `POST` | `/cart/checkout` | Revalidates, creates the `orders` row, returns a Stripe Checkout URL |
| `GET` | `/orders` | The user's order history, paginated |
| `GET` | `/orders/:id` | One order with items and fulfilment status |
| `GET` | `/explore/bestsellers` | Public-ish leaderboard, mirrors `/explore/trending` |

Keying cart mutations on `bookId` rather than `cartItemId` is deliberate: the
client already holds book ids everywhere, and it makes every mutation idempotent
from the app's point of view. Quantity is capped (proposal: 10 per line, 20 per
cart) — this is a books shop, and Gardners' dropship service is home delivery,
not trade.

## Checkout flow

```
POST /cart/checkout
  ├─ load active cart, reject if empty
  ├─ re-read gardners_stock for every ISBN
  │    └─ price moved or stock gone → 409 { changes: [...] }, cart updated in place
  ├─ resolve presentment currency + pin fx_rate
  ├─ compute shipping from env rules  (SHIPPING_RATES)
  ├─ compute tax from env rules       (VAT_RATES)
  ├─ INSERT orders (pending_payment) + order_items  ── one transaction
  ├─ stripe.checkout.sessions.create({
  │     mode: 'payment',                 ← subscriptions use mode: 'subscription'
  │     currency: <presentment currency>,
  │     line_items built SERVER-SIDE from order_items,
  │     shipping_address_collection: { allowed_countries: <all Stripe-supported> },
  │     customer: <existing stripe customer id, reused from userSubscriptions>,
  │     metadata: { orderId, userId },
  │     client_reference_id: orderId,
  │   })
  └─ 200 { url, orderId }
```

**The shipping address is collected by Stripe, after the price is fixed.** That
ordering is a real problem worth naming: shipping cost and VAT both depend on
destination, but we don't know the destination until the customer is already
inside Stripe's checkout. Two ways out, and the choice should be made in Phase 2:

- **(a) Ask for the destination country first**, in our own UI, before creating
  the session — one extra field, exact pricing, no surprises. Recommended.
- **(b) Use Stripe's dynamic `shipping_options`** with rates precomputed per
  region and let Stripe apply the right one. Fewer clicks, but every rule has to
  be expressed in Stripe's model rather than ours, and the env-configurable
  design goes out the window.

Whichever wins, the address must be **validated against the Gardners constraints
before payment**, not after — see below.

Then, asynchronously:

```
Stripe webhook (existing route, existing stripe_webhook_events idempotency)
  └─ checkout.session.completed  AND  session.mode === 'payment'
       ├─ resolve order by metadata.orderId (never by guessing)
       ├─ mark paid, store payment_intent, persist the collected shipping address
       ├─ mark cart converted
       ├─ write one 'purchase' user_interaction per line
       └─ enqueue fulfilment job
                └─ gardnersDropshipOrderService.createAndSubmit({ lines })
                     → order.status = submitted_to_supplier
        (a separate cron polls pollAck → acknowledged | supplier_rejected)
```

Three things to get right here:

- **Reuse the existing webhook route and its idempotency table.** Branch on
  `session.mode` at the top of the handler; do not add a second Stripe endpoint.
  Everything in the "Stripe is the source of truth / at-least-once / never guess
  the user" doctrine at the top of `webhooks.service.ts` applies unchanged.
- **Fulfilment must be a queued job, not inline in the webhook.** Gardners is an
  SFTP round-trip against a UK server; a webhook handler that blocks on it will
  time out and Stripe will redeliver. Payment success must never depend on
  Gardners being up.
- **Never build Stripe `line_items` from the request body.** Prices come from the
  `order_items` rows the server just wrote — same principle as `resolvePrice()`
  in the subscription checkout.

### Fulfilment gaps to close

`gardners-dropship` was built to prove the flow, and its own header comment lists
what it skipped. Two of those become blocking once real money is involved:

- **Development cannot reach Gardners at all.** `withDropshipSftp` refuses to
  connect while `NODE_ENV=development`, since local `.env` files carry real
  supplier credentials for the catalogue feeds. Opt out deliberately with
  `GARDNERS_DROPSHIP_ALLOW_IN_DEV=true`.
- **`testing` defaults to `true`** (`config.gardnersDropship.defaultTesting`).
  Gardners acknowledges the file but ships nothing. Flipping this for real orders
  is a deliberate, gated step in Phase 3 — not a config change someone makes by
  accident.
- **No refund or cancellation path.** Dispatch (`.HDD`), backorder
  (`BACKORD.TXT`), and cancellation (`.CRF`/`.CRA`) are unimplemented. Until they
  are, a customer refund is a manual Stripe-dashboard action plus a phone call to
  Gardners. That is survivable at launch volumes but must be a conscious
  decision, and `orders.status = refunded` should exist from day one so the
  manual action can at least be recorded.
- **Address mapping is lossy.** Every Gardners address field is `varchar(35)`,
  postcode is 8, and `country` **must match the Gardners I12d country list
  exactly** — Stripe returns ISO-3166 alpha-2. This needs a real mapping table
  and a validation step at checkout (reject at the Stripe redirect, not after
  payment, or you take money for an order you can't ship). Also the routes are
  currently mounted admin-side only; the customer flow should call the *service*
  directly, not the HTTP endpoint.

## Bestsellers

### Does Gardners already give us this? **No.**

All eight Gardners feeds are inventory and bibliographic: Bespoke Inventory
(price/stock), ONIX Biblio, Avail13 (hourly stock), Promotions, Firm Sale,
Slipped ISBNs, Market Restrictions, Cover Images. None carries a sales rank, a
units-sold figure, or a bestseller chart. `gardners_promotions` is the closest
thing — publisher-funded promotional titles — but that is *marketing spend*, not
sales performance, and presenting it as a bestseller list would be wrong.

So bestsellers must come from **our own `order_items`**. Third-party charts
(Nielsen BookScan, the official UK source) are a paid licence and a separate
decision.

### Design

A book's rank is `SUM(quantity)` over `order_items` joined to `orders` where
`status` is paid-or-beyond, within a time window. Two consequences:

- **Cold start.** Day one there are zero orders and the list is empty — and it
  stays empty. **Decision reversed during the build** (2026-08-11): the original
  plan proposed falling back to trending below a minimum order count. Live, that
  produced a "bestsellers" list of books published in 2031, because the trending
  feed's own fallback sorts by `publication_date DESC` over a catalogue full of
  far-future ONIX placeholder dates. Substituting one feed for another is
  unsound regardless: the client cannot tell a real chart from a stand-in.
  Empty is the correct answer, and the section is hidden client-side.
- **Windows.** `all_time`, `90d`, `30d`, `7d`. Ranking is over completed orders
  only, so a refunded order should decrement — hence the aggregate is computed
  from `order_items`, not incremented from a counter.

Implementation, mirroring how `booksService.trending()` already works: a scored
SQL query behind a Redis cache (`bestsellers:v1:<window>:<genre>:<limit>`), with
a nightly cron refresh rather than computing on every request. Add a
`(created_at, book_id)` covering index on `order_items` for the window scan.
Genre-filtered variants join `book_genres`, which has known coverage gaps — the
same caveat `recommendations.service.ts` already documents.

Separately: once real purchases exist, add `'purchase'` to
`TRENDING_SCORED_TYPES` in `interactions.service.ts`. It is already weighted (6,
the highest) and deliberately excluded only because nothing writes it. That is a
one-line change with a real effect on the trending feed, so it should land
consciously and be noted in the changelog.

## Phases

1. **Cart** — `carts`/`cart_items` migration, service, controller, routes, tests.
   Ships standalone and is useful (and safe) with no payment attached.
2. **Pricing + orders + Stripe payment mode** — the pure pricing helpers
   (currency resolution, FX, minor units, shipping rules, VAT rules),
   `orders`/`order_items`, checkout session, webhook branch, order history.
   Test-mode Stripe keys, no fulfilment. Verifiable end to end with Stripe CLI.
   Bigger than it looks — the pricing helpers are most of it.
3. **Fulfilment** — queued Gardners submission, ack-polling cron, address
   mapping + validation, the `testing: false` cutover. Highest-risk phase; it is
   the only one where a bug spends real money.
4. **Bestsellers** — aggregate query, cache, cron, endpoint, trending-fallback,
   enable the `purchase` trending signal.

Each phase gets a `changelog/<date>-<slug>.md` write-up per `CLAUDE.md`, and the
schema lives in `server/src/db/schema/` with a real drizzle-kit migration — the
server owns migrations, not `onix_ingester`.

## Decisions

Confirmed 2026-08-10.

1. **Buying is not gated behind Kinkané Plus.** Cart, checkout and order history
   are `requireAuth` only. Gate the bookshelf, not the till.
   *Still open:* `POST /user-books/:bookId/like` currently sits behind
   `requirePlus`. Leaving it there is defensible (the shelf is the paid feature),
   but it will read oddly next to an ungated cart, and a "like" is the most
   natural precursor to a purchase. Flagging, not changing.
2. **Signed-in only.** No guest carts. `guest_sessions` stays an onboarding
   concept; there is no cart-merge-on-signup path to build or test.
3. **Ship anywhere, for now.** `allowed_countries` is left unrestricted rather
   than enumerated. Two consequences that must be built, not deferred:
   - **`gardners_market_restrictions` has to be enforced at add-to-cart**, keyed
     on the destination country's region. An open shipping list makes this the
     *only* thing standing between us and selling a title we have no right to
     sell into that territory. It is not optional.
   - The Gardners `serviceCode` is destination-dependent — the dropship module
     hardcodes `'011'` (Overseas Airmail Tracked), which is wrong for UK
     domestic. **Resolved**: I12 spec page 11 gives the table — `001` Standard
     UK (2nd Class), `002` Premium UK (1st Class), `010` Airmail untracked,
     `011` Airmail Tracked, `015` BFPO. UK now goes out as `001`, everywhere
     else as `011`; both are confirmed against the spec's worked examples and
     our own accepted `.ACK` files.
   - **Gardners enforces market restrictions server-side as well** (spec page
     11): a restricted title comes back with Quantity Supplied `0` and a report
     of `N/A`, order cancelled. A real backstop, but not a substitute for the
     add-to-cart check — by the time the `.ACK` lands, the customer has paid.
4. **Shipping cost is env-configurable.** Expressed in GBP pence (base currency),
   converted for presentment like everything else:
   ```
   SHIPPING_RATES=GB:299,IE:599,EU:699,US:899,ROW:1199
   SHIPPING_PER_ITEM_GBP_PENCE=0
   SHIPPING_FREE_THRESHOLD_GBP_PENCE=4000
   ```
   Resolution is most-specific-first: country code → region → `ROW`. The chosen
   rule is recorded on the order in `shipping_rule`. Note Gardners bills us
   **per line** (`deliveryGbpPence`), so a flat per-order rate on a five-book
   order is a margin decision — worth watching once real orders exist.
5. **VAT is env-configurable.**
   ```
   VAT_RATES=GB:0,IE:0,DE:7,FR:5.5,US:0
   VAT_DEFAULT_RATE_PERCENT=0
   VAT_PRICES_INCLUDE_TAX=true
   ```
   Env is the right home for shipping because shipping is *our pricing policy*.
   VAT is different in kind — it is external law, changing on someone else's
   timetable, and properly depends on destination *and* product type *and* our
   registration status *and* turnover thresholds. An env table expresses only the
   first of those.

   **Env is still correct for launch**, for reasons specific to this catalogue:
   there is a single tax class (Gardners' non-ISBN EANs — jigsaws, cards — are
   already filtered on the 978/979 prefix at ingestion, so there is no mixed
   basket of differently-rated goods); UK physical books are genuinely
   zero-rated; and on export we do not collect destination VAT at all, since
   below distance-selling thresholds the recipient is billed import VAT and duty
   at the border.

   **Which makes disclosure, not the rate table, the real exposure.** Under
   decision 3 a customer in Germany or Canada pays at checkout and then meets a
   customs bill before the courier hands over the parcel. That generates refund
   requests and chargebacks, and no VAT configuration prevents it — it needs
   wording in the checkout UI and the confirmation email. Rank it above getting
   the rates right.

   Three tiers, one interface: **env** now (`VAT_SOURCE`-equivalent recorded as
   `tax_source` per order, so a later correction can find affected rows) →
   **Stripe Tax** when volume or destinations grow (natural fit on Checkout,
   handles registration thresholds, ~0.5% per transaction) → a **DB table** only
   if per-category rates are ever needed, which the single tax class makes
   unlikely. What keeps the swap cheap is `quoteTax()` being a pure function
   returning `{ ratePercent, gbpPence, source }`; env is an implementation
   detail, not an architectural commitment.

   `VAT_PRICES_INCLUDE_TAX` defaults to **false** — tax added on top. It is moot
   at 0%, but for any non-zero destination it decides whether the rate comes out
   of our margin (inclusive) or the customer's total (exclusive), and that should
   be chosen deliberately rather than inherited from a default.
6. **Currency follows location, defaulting to USD.** Full design in
   [Money](#money-two-currencies-one-source-of-truth) above — this is the
   decision with the widest blast radius, since it forces every order to carry
   both a GBP supplier-side amount and a presentment amount with a pinned FX
   rate.

### Consequences worth restating

- **Phase 2 grew.** Currency resolution, the FX helper, minor-unit handling, the
  shipping-rule resolver and the VAT resolver are all Phase 2 work now, and each
  wants unit tests of its own. The pricing helpers should be pure functions over
  `(gbpPence, countryCode, config)` so they can be tested without a database.
- **Decisions 3 and 5 interact badly if ignored.** Shipping anywhere with VAT
  defaulted to 0 means a parcel to Germany carries no tax and no duty handling.
  That is legal exposure sitting in a config default — acceptable at launch
  volumes with a small number of destinations, unacceptable quietly at scale.
  Worth a deliberate review before Phase 3's `testing: false` cutover.
- **An open country list makes address mapping the top fulfilment risk.**
  Gardners' `varchar(35)` fields and exact-match country list were already the
  sharpest edge; shipping to arbitrary countries maximises how often we meet it.

  The country list turned out **not to be in the specification PDF at all**.
  Page 9 points at a separately-distributed `I12d FTP Country List.txt`, to be
  requested from `ITServices@gardners.com`. Only `UNITED KINGDOM` (spec
  examples) and `GHANA` (our own accepted orders) are confirmed; the rest of the
  built-in table is an educated guess, tagged as such per entry, and overridable
  from the environment via `GARDNERS_COUNTRY_NAMES_EXTRA` so the real list needs
  no deploy. Checkout refuses an unmapped destination *before* creating the
  Stripe session, so the failure mode is a lost sale rather than a paid order
  that cannot be shipped.

  **Open action:** email `ITServices@gardners.com`, quoting the Gardners account
  number, for `I12d FTP Country List.txt`.

- **BFPO (service `015`) is not wired up.** It needs the BFPO number inside the
  address and is a different address shape, so it is a feature rather than a
  branch. Worth knowing it exists if UK military addresses ever come up.
