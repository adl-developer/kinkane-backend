# Buying books: cart, checkout, fulfilment and bestsellers

Kinkané can now sell books. Until this change the app could recommend a book,
shelve it and let you like it, but there was no way to buy one — the only
purchase path in the codebase was an admin-only Gardners dropship endpoint built
to prove the wholesale order cycle.

Four things landed together, in dependency order: a cart, a Stripe checkout, a
queued hand-off to Gardners for delivery, and a bestseller chart built from the
resulting orders.

Planning document: `docs/ecommerce-plan.md`.

## What already existed

Worth stating, because it shaped nearly every decision below. Likes were already
built (`user_books.liked`, `POST|DELETE /user-books/:bookId/like`) and are
untouched here. Stripe was already integrated for Kinkané Plus — client, webhook
route, signature verification, idempotency table. Gardners dropship ordering
already worked end to end. Live price and stock per ISBN were already being
ingested daily and hourly into `gardners_stock`.

So this change is mostly *connective*: four new tables, a pricing layer, and the
wiring between pieces that already existed.

## The money model

This is the part to understand before changing anything.

Gardners quotes GBP and only GBP. Customers see and are charged their own
currency, defaulting to USD. So every order carries **both**:

- `*_gbp_pence` — the supplier-side truth. What fulfilment submits and what
  margin reporting reads. Never converted.
- `presentment_currency` + `*_minor` — what Stripe actually charged, in that
  currency's minor unit.
- `fx_rate` + `fx_captured_at` — pinned at checkout, so the amount displayed is
  provably the amount charged and a rate change tomorrow cannot make a
  historical order look mispriced.

Conversion rules live in `src/lib/money.ts` and are deliberately opinionated:
money is always an integer in a currency's minor unit; the minor unit is *not*
always 1/100 (JPY has none, KWD has three decimals and Stripe wants multiples of
100); and conversion always rounds **up**, because rounding down loses real money
on every line of every order.

Rates come from a static env table (`FX_RATES_FROM_GBP`) padded by
`FX_BUFFER_PERCENT`. That is a launch trade — no external dependency inside the
checkout path, at the cost of drift — and the buffer is what makes the drift eat
padding rather than margin. Swapping in a daily rates feed later is a change
behind the same interface.

Prices come from `gardners_stock.rrp_gbp`, not `book_prices`. `book_prices` is
ONIX edition metadata, multi-currency, and covers only about half the catalogue.
`discount_percent` on the same row is the trade discount *we* receive — our
margin — and is never applied to a customer-facing price.

## API

All under `/api/v1`, all `requireAuth`, and — deliberately — **no `requirePlus`
anywhere**. Buying is open to every signed-up user. Gate the bookshelf, not the
till.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/cart` | Live-priced cart with per-line `priceChanged` / `unavailable` / `stockQty` |
| `POST` | `/cart/items` | `{ bookId, quantity? }` — quantity is a **delta** |
| `PATCH` | `/cart/items/:bookId` | `{ quantity }` — **absolute**; `0` removes the line |
| `DELETE` | `/cart/items/:bookId` | Remove a line |
| `DELETE` | `/cart` | Empty the cart |
| `POST` | `/cart/checkout` | `{ shippingCountry, currency? }` → Stripe Checkout URL |
| `GET` | `/orders` | Order history |
| `GET` | `/orders/:id` | One order with lines |
| `GET` | `/explore/bestsellers` | `?window=7d\|30d\|90d\|all_time&limit=` |

Add is a delta and PATCH is absolute because those match how the two controls
actually behave — "add another" is cumulative, a stepper sets a number.
Conflating them is how carts end up with 14 copies of one book. Both are keyed on
`bookId` rather than a cart-item id, so every mutation is idempotent from the
client's point of view.

## Non-obvious decisions

**The cart stores intent, not a quotation.** Quantities are durable; prices are
not. Every read re-prices against the live feed. The stored
`unit_price_gbp_pence` exists solely so the cart can *tell the user* their price
moved — which is impossible without remembering what it was.

**Checkout asks for the destination country before Stripe, not after.** Shipping
and tax are both priced from the destination, but Stripe only collects an address
*after* the amount is fixed. So `POST /cart/checkout` requires
`shippingCountry`, prices everything against it, and then locks Stripe's
`shipping_address_collection` to that single country. The buyer can correct any
part of their address except the one that would invalidate what we quoted. The
alternative — Stripe's dynamic `shipping_options` — would mean expressing every
shipping and tax rule in Stripe's model rather than our configuration, which is
the thing the env-driven design exists to avoid.

**A 409 from checkout is a normal outcome, not an error.** If a price or stock
level moved, checkout repairs the cart in place and *then* returns 409 with a
`changes` array. The client shows the user what changed and retries; nobody
rebuilds a basket.

**One webhook endpoint, not two.** `checkout.session.completed` fires for both
products; `session.mode` plus a `kind: 'order'` metadata tag is the
discriminator. Delivery, signature verification and the
`stripe_webhook_events` idempotency claim stay in one place — two endpoints would
mean two places an event can be double-processed.

**Fulfilment is queued, never inline in the webhook.** Submitting to Gardners is
an SFTP round trip to a UK server. Blocking the webhook on it would time out and
make Stripe redeliver an event whose payment side was already recorded. Payment
success must never depend on our supplier being reachable. The queue uses the
order id as its `jobId`, so a redelivered webhook cannot place a duplicate order,
and runs at concurrency 1 because Gardners' end is a legacy system with no stated
concurrency guarantees.

**A failed fulfilment leaves the order `paid`.** Not a failure status — the
customer has been charged and is owed their books, and moving the row out of
`paid` would hide it from retries and make it look resolved. The error text lands
on `orders.fulfilment_error_message`, and the fulfilment queue is registered in
Bull Board so an operator can find and retry it.

**Market restrictions fail closed, once, on purpose.** With an open shipping
country list, `gardners_market_restrictions` is the only thing standing between
us and selling rights-restricted titles into territories nobody has checked.
Gardners' region vocabulary is its own and does not map to ISO-3166, so the
mapping is operator-supplied (`GARDNERS_REGION_BY_COUNTRY`) and ships **empty**.
While it is empty, a title that *has* restriction rows is blocked; titles with
none — the overwhelming majority — are unaffected. A guessed mapping would be
worse than no mapping.

**Bestsellers count copies, never revenue.** Ranking by money would order books
differently depending on which currency their buyers happened to be in. Only
paid-or-beyond statuses count, so a refund correctly removes copies from the
chart.

**Bestsellers return an empty list until books actually sell.** No fallback to
trending, no padding, no substitution. A discovery feed presented as a sales
chart is a lie about the shop, and — critically — it is indistinguishable to the
client from a real chart. Empty is honest and unambiguous: nothing has sold in
this window. Clients hide the section when `books` is empty.

An earlier cut fell back to trending below a 20-copy floor. That was wrong twice
over: it substituted unrelated data for the answer, and because the trending
feed itself falls back to `ORDER BY publication_date DESC` when interactions are
thin, the "bestsellers" being shown were in fact the far-future end of the ONIX
catalogue — books published in 2031. The floor went with the fallback: with no
substitute to reach for, suppressing five genuine sales would hide real
information rather than protect anyone from noise.

## Does Gardners supply bestseller data? No.

Asked and answered during planning, and worth recording so nobody re-derives it.
All eight Gardners feeds are inventory or bibliographic — Bespoke Inventory, ONIX
Biblio, Avail13, Promotions, Firm Sale, Slipped ISBNs, Market Restrictions, Cover
Images. None carries a sales rank or a units-sold figure. `gardners_promotions`
is the closest thing and is deliberately unused: promotional titles are publisher
marketing spend, not sales performance. Nielsen BookScan is the licensed UK chart
source if an external chart is ever wanted.

## Rebased onto the referral competition (PR #47)

This branch was cut before `feat/referral-competition` merged, and the two
overlapped in exactly the place predicted at the time: both introduced
`GEO_COUNTRY_HEADER`, and both claimed migration number `0032`. Reconciled as:

- **One country resolver, not two.** Commerce's own header lookup is gone;
  `resolveRequestCountry()` now delegates to `geoService.resolveFromRequest`,
  which the referral work brought with it and which additionally consults a
  local MaxMind database. Currency display and referral scoring have to agree
  about where a request came from — two implementations would eventually
  disagree. The call is async now, so the three cart-controller call sites await
  it.
- **Live vs frozen country, deliberately different.** Referrals freeze country
  at signup so nobody shifts continent mid-competition. Currency resolves live
  per request, because someone who signed up in Lagos and now lives in Berlin
  should see EUR.
- **Migration renumbered `0032` → `0034`**, behind main's `0032` and `0033`. It
  is purely additive — four tables and two enums, no `DROP`, and it does not
  touch `users`, `referrals` or `countries`.
- **`.env.example` now documents `GEO_COUNTRY_HEADER` and `MAXMIND_DB_PATH` as
  shared**, under their own heading rather than inside the commerce block.
  Worth flagging separately: PR #47 added four env vars (`REFERRAL_VIDEO_URL`,
  `REFERRAL_CAMPAIGN_ENDS_AT`, `GEO_COUNTRY_HEADER`, `MAXMIND_DB_PATH`) and
  documented none of them in `.env.example`. Only the two commerce depends on
  were added here; the referral pair is still undocumented.
- `APP_URL` moved to **kinkane.app** on main. The order success/cancel URLs
  derive from it, so they followed automatically — nothing hardcoded a domain.

## Also changed

- `source` in the bestsellers response is now always `'orders'`. The field is
  retained rather than removed because clients were told to key their section
  heading off it, and a field vanishing is a worse break than a constant one.
- `booksService.listByIds()` — fetches books by id **preserving the given
  order**, for ranked feeds. An `IN (...)` lookup returns rows in whatever order
  the planner likes, which would silently scramble a chart.
- `wrapHttp()` in `src/lib/route-helpers.ts` — turns a service-thrown
  `statusCode` into that response instead of a blanket 500. Every controller was
  re-implementing the same try/catch; this does it once. 5xx and unannotated
  errors still fall through to the global handler with their stack intact.
- `'purchase'` interactions are now written for the first time — the strongest
  signal in the system (weight 6) and, until now, one nothing ever produced.

## Nothing reaches Gardners in development

`withDropshipSftp` — the single choke point every Home Delivery call goes
through — refuses to connect while `NODE_ENV` is `development`. That covers the
queued fulfilment worker, the ack-polling cron and the admin endpoint in one
place.

The reason it is a hard block rather than a soft one: running the API locally
normally means having **real Gardners credentials in `.env`**, because the
catalogue feeds need them. Without this, clicking through a local checkout would
put a genuine order file into a genuine supplier's HOMEORD directory as a side
effect. `TESTING=Y` is not sufficient protection — it is a per-order flag
someone can turn off, and it still transmits.

Two details worth knowing:

- **The guard runs before the credential check**, so a blocked environment fails
  identically whether or not credentials happen to be present. The test supplies
  full credentials precisely so it cannot pass for the wrong reason.
- **Fulfilment returns rather than throwing.** A throw would burn all six queue
  retries and then sit in Bull Board looking like a real failure on every local
  checkout. The order stays `paid` — which is true, it *is* awaiting fulfilment
  — with a note on `fulfilment_error_message` saying why nothing was sent.

`GARDNERS_DROPSHIP_ALLOW_IN_DEV=true` is the deliberate opt-out, defaulting to
false. It exists for one caller: `scripts/gardners-dropship-test.ts`, whose
whole purpose is to talk to Gardners from a developer machine. That script's
usage line now carries the variable, and the thrown error names it, so the fix
is never a code hunt.

## One payment reference for every checkout

Both checkout flows now return a `paymentReference` (`KP-` + 12 characters)
alongside the Stripe URL, and `GET /api/v1/payments/:reference` exchanges it for
a status. The mobile app stores one opaque string and never branches on whether
it bought a subscription or a basket of books.

This closes a real hole: the app opens Stripe in a webview, and on return it had
no reliable signal about the outcome. The subscription flow handed back a `cs_…`
session id and the order flow handed back an integer order id — neither of which
a client should be reasoning about, and neither of which answered "did the money
arrive".

Three things worth knowing about the design:

- **The confirm read falls through to Stripe.** The user comes back from the
  Stripe page in well under a second, routinely before the webhook lands. A
  database-only answer would say `pending` at exactly the moment the user is
  looking at the screen. So while our row is pending we retrieve the session
  from Stripe and write the answer back — the first call usually gets a
  definitive result. Repeat calls within two seconds are served from our record,
  so a client polling in a tight loop cannot turn one screen into a Stripe API
  flood.
- **`status: 'complete'` is not `paid`.** Stripe splits this across two fields:
  `status` describes the session, `payment_status` describes the money. A
  delayed-settlement method completes the session while funds are still in
  flight, so `statusFromSession` requires both, and reports `pending` otherwise.
  Reporting that as success would hand over goods for money that never arrived.
- **404 covers "not yours" as well as "no such reference".** Ownership is part
  of the lookup, not a check afterwards, so the endpoint cannot be used to probe
  whether someone else's reference exists.

`payment_intent.payment_failed` deliberately does **not** mark a reference
failed. Stripe Checkout lets a user retry a declined card within the same
session, so the session — and therefore the payment — is still live. The
read-through reconcile reports the true state instead.

## In-app subscription cancellation

`POST /user/subscription/cancel` and `POST /user/subscription/reactivate`.

Previously the only way to cancel was the Stripe-hosted Billing Portal. That is
a reasonable default for a web app and a poor one for a native app: stopping
payment meant being handed out to a Stripe-branded web page. Cancellation is
also the one billing action that is genuinely simple — a single
`cancel_at_period_end` flag — unlike plan switches and card updates, which carry
proration, dunning and SCA and stay in the portal.

**Cancellation is scheduled, never immediate.** The user has already paid for
the current term; revoking access on click destroys value they bought and
produces a refund request. Stripe stops billing, they keep Plus until
`accessEndsAt`, and the client renders that from `cancelAtPeriodEnd` +
`accessEndsAt`. A successful cancel therefore still returns `tier: 'plus'`,
which is correct and worth saying out loud to the client team.

**Reactivate ships in the same change, not later.** It is the request that
always follows a cancel button, and without it an accidental cancel can only be
undone by a fresh checkout — new billing date, and during the launch window the
loss of the Founding Member price.

Two smaller decisions:

- **State is mirrored locally rather than awaiting the webhook.** The user is
  looking at the account screen when they press the button; waiting for
  `customer.subscription.updated` would leave it claiming the subscription is
  still renewing, and they would press cancel again. The webhook still arrives
  and writes the same state — these handlers write what the event describes
  rather than applying a delta, so agreement is the normal case. It also means
  cancellation works locally without `stripe listen`.
- **A trialing user gets `409 NO_PAID_SUBSCRIPTION`, not a 500.** The 90-day
  trial is ours, not Stripe's, so there is no subscription object to cancel and
  no charge to stop.

## Explicitly out of scope

- **Guest carts.** Signed-in only. Cart-merge-on-signup doubles the surface area
  of every cart endpoint.
- **Refunds and cancellations.** The dropship module has no `.CRF`/`.CRA` flow,
  no dispatch (`.HDD`) polling and no backorder reconciliation. A refund is a
  manual Stripe action plus a call to Gardners; `charge.refunded` is handled so
  the order and the bestseller chart at least stay correct.
- **Turning on real orders.** `GARDNERS_DROPSHIP_DEFAULT_TESTING` still defaults
  to `true`, so Gardners acknowledges files and ships nothing. Flipping it is a
  deliberate step, not a side effect of this change.
- **`'purchase'` in the trending feed.** The signal is now written but is still
  absent from `TRENDING_SCORED_TYPES`. Adding it is one line and will visibly
  move the trending list, so it should land on its own.

## Delivery service codes — verified against the spec

Page 11 of the I12 specification carries the authoritative table, and it
confirms the code the first cut guessed:

| Code | Service |
| --- | --- |
| `001` | Standard UK Delivery — 2nd Class, two-day average |
| `002` | Premium UK Delivery — 1st Class, next day if before 3pm |
| `010` | Airmail untracked — 5-7 days Western Europe, 7-10 elsewhere |
| `011` | Airmail Tracked — same timings, tracked to destination |
| `015` | BFPO — requires the BFPO number in the address |

So UK orders now go out as `001` and everything else as `011`. Both are
confirmed in two directions: the spec's own UK worked examples send
`"SERVICE",001`, and our accepted Ghana orders (`000000043`, `000000044`) sent
`"SERVICE",011` and came back acknowledged with Gardners references issued.

An undocumented code is rejected per-line in the .ACK as
`"ERROR","SERVICE",070` / `<This is not a valid Service Code>` (page 15).

**One spec contradiction, resolved.** Page 10 says the tracking flag "is used in
conjunction with the Service codes 001, 002, 010 only" — which would make our
`TRACKING,"Y"` on an `011` order wrong. Page 11, describing `011` directly, says
the opposite: "Although this is already a Tracked service, you will need to
select 'TRACKING','Y' to allow the other related TRACKED fields to be used."
Page 11 wins — it is the more specific statement, and it matches observed
behaviour, since our `011` + `TRACKING,"Y"` orders were accepted. BFPO is the
one service that does not take tracking, and `supportsTracking()` encodes that.

## The country list is not in the spec PDF

This could not be done as asked, and the reason is worth recording. Page 9:

> DCOUNTRY and ICOUNTRY fields must always contain the full country as listed in
> the "I12d FTP Country List.txt" file.

That file is distributed separately — "If you require a copy of the 'I12d FTP
Country List.txt' eMail: ITServices@gardners.com". It is not in `EDI_docs/`, and
the PDF contains no country table anywhere.

Generating one from ISO-3166 or `Intl.DisplayNames` was considered and rejected.
Page 9 also says the list keeps retired names for historic continuity, so "some
countries may appear more than once under a different name" — meaning a
correct-looking modern name can still be the wrong one. And the cost of being
wrong is stated plainly: an unrecognised country is "manually reviewed by our
customer support team... Any manual intervention will delay the order
processing, and for repeat offenders could also result in your account being
suspended".

What was done instead, in `services/commerce/gardners-countries.ts`:

- The table is hand-kept and **every entry is tagged with its confidence** —
  `[VERIFIED]` (accepted by Gardners in a real .ACK: `GHANA`), `[SPEC]`
  (verbatim in the spec's examples: `UNITED KINGDOM`), or `[UNVERIFIED]` (our
  best guess — everything else). Coverage went from ~22 to ~80 countries, but
  the honesty about which are proven matters more than the count.
- `GARDNERS_COUNTRY_NAMES_EXTRA` overrides and extends it from the environment,
  so the real list can be applied **without a deploy** the moment it arrives.
- **Checkout now refuses an unmapped destination before creating the Stripe
  session.** This is the substantive fix: previously the country was only
  resolved at fulfilment, i.e. after the card had been charged, which meant
  refunding an order we could never have shipped. The failure mode is now a lost
  sale, not a stuck paid order and a manual refund.

The one action that closes this properly: email ITServices@gardners.com quoting
the Gardners account number and ask for `I12d FTP Country List.txt`.

## Also confirmed while reading the spec

**Gardners enforces market restrictions server-side too** (page 11): ordering a
title restricted in the destination returns Quantity Supplied `0` and a report
of `N/A`, and the order is cancelled rather than created. That is a genuine
backstop behind our own add-to-cart check — but it does not replace it, because
by the time an .ACK arrives the customer has already been charged. Our
fail-closed check is what stops taking money for a title we cannot sell there.

## Known gaps before real money moves

1. **Country names are still mostly unverified** — see above. Only `GB` and `GH`
   are proven. Checkout blocks unmapped destinations, so the risk is a rejected
   or delayed order for a mapped-but-misnamed country, not a silent failure.
2. **Customs disclosure.** Shipping anywhere with VAT defaulting to 0 means some
   customers receive an unexpected import-duty bill. That is a refund and
   chargeback generator, and it needs wording in the checkout UI and confirmation
   email — no config value fixes it.
4. **`UNSUPPLIABLE_REPORT_CODES` was assembled from observed feed values**, not
   from Gardners' published code list. It fails open, so a missing dead code
   surfaces as a rejected dropship line rather than a lost sale.

## How it was verified

- `npx tsc --noEmit` clean.
- 36 unit tests in `src/__tests__/commerce-pricing.test.ts` covering minor
  units and zero-decimal currencies, Stripe's three-decimal rule, rounding
  direction, the FX buffer, currency resolution precedence, shipping
  most-specific-first resolution and its free-shipping override, inclusive vs
  exclusive tax, whole-order totals summing to their own presented parts, and
  the Gardners service-code and country-name tables (including that every name
  is upper case and abbreviation-free, as the spec demands).
- Full suite: 133 passing. Three pre-existing failures in
  `subscription-pricing.test.ts` are unrelated — they fail identically on `main`,
  caused by the local `.env` leaking real Stripe keys into cases that assert
  "not configured".
- Delivery service codes and the two known country names were read directly out
  of the I12 specification PDF and cross-checked against the `.ORD`/`.ACK` pairs
  in `EDI_docs/` — real files we sent and Gardners accepted.
- **Not yet exercised against live Stripe or live Gardners.** No checkout session
  has been created against test-mode Stripe and no `.ORD` file has been
  submitted. Both need doing before this is considered proven — the Gardners
  work in particular has a track record of bugs that are invisible from reading
  the code and only appear on a real run.
