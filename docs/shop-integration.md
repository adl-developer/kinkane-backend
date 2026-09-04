# Shop Client Integration Guide

How the web and mobile clients build the basket, checkout and order-tracking
flows against this backend. Covers the sequence, the state the client has to
keep, and the things a schema can't tell you on its own.

Full field-by-field contracts live in the OpenAPI spec at `GET /openapi.json`
(Swagger UI on the same host). **Where this guide and the spec disagree, the
spec is correct** — it is generated from the running code.

## The one rule that shapes everything

**Before someone signs in, their basket lives entirely on the client.** The
backend stores nothing — no cart record, no identifier, no trace of a visitor
who never creates an account. The client holds a list of book ids and quantities
and asks the server to price it whenever the basket is rendered.

Once the user signs in, the basket becomes server-side: the client replays its
lines into the stored cart and uses the cart endpoints from then on.

**The client never sends prices and the server never reads them.** Every request
carries book ids and quantities only; all prices, sale prices, stock figures and
totals are computed server-side from the live wholesaler feed. This means a
client cannot get a price wrong — but it also means a price must not be cached
and assumed to hold. Re-price whenever the basket is rendered.

## Buying as a guest

### 1. Keep the basket locally

Store an array of `{ bookId, quantity }`. That is the whole basket — nothing
else needs persisting at this stage.

### 2. Price it whenever it is shown

`POST /api/v1/cart/price` — no auth, nothing stored.

```jsonc
// request
{
  "lines": [{ "bookId": 48213, "quantity": 3 }],
  "currency": "GBP"          // optional
}

// 200
{
  "currency": "GBP",
  "lines": [{
    "bookId": 48213,
    "title": "Girl, Woman, Other",
    "quantity": 3,           // what they asked for
    "availableQuantity": 2,  // what can actually ship
    "unitPriceMinor": 1299,
    "lineTotalMinor": 2598,  // priced on availableQuantity
    "compareAtMinor": null,  // non-null = on sale
    "unavailable": false,
    "unavailableReason": null
  }],
  "subtotalMinor": 2598,
  "estimatedShippingMinor": 399,
  "totalMinor": 2997,
  "hasIssues": true
}
```

When `availableQuantity` is below `quantity`, show "only 2 available" rather
than silently reducing the stepper — the user chose 3 and deserves to know why
they are getting 2.

Duplicate `bookId` entries are merged rather than rejected.

### 3. Check out

`POST /api/v1/cart/checkout`. The address's `countryCode` is what shipping and
tax are priced on.

```jsonc
// request
{
  "lines": [{ "bookId": 48213, "quantity": 2 }],
  "contactEmail": "rachel@example.com",
  "contactPhone": "+233201234567",
  "shippingAddress": {
    "name": "Rachel TM",
    "line1": "19 H P Nyemitei St",
    "line2": null,
    "city": "Accra",
    "region": null,
    "postcode": "GZ-188-608",
    "countryCode": "GH"
  },
  "currency": "GBP"
}

// 200
{
  "url": "https://checkout.stripe.com/c/pay/...",
  "orderId": 1042,
  "reference": "ORD-7K2M9QX4",
  "accessToken": "v4Xk9...",   // returned ONCE
  "currency": "GBP",
  "totalMinor": 2997
}
```

Passing `shippingCountry` instead of `shippingAddress` still works — Stripe then
collects the address, locked to that country. Send one or the other.

### The first-order discount is applied at checkout, and nowhere earlier

When `FIRST_ORDER_DISCOUNT_PERCENT` is set, an order whose email has never paid
for anything before gets that percentage off the goods automatically. There is
no code to type, and nothing for the client to send.

The checkout response carries `discountMinor` and `discountReason`, and the
components always reconcile:

```
subtotalMinor - discountMinor + shippingMinor + taxMinor === totalMinor
```

**The basket endpoints deliberately do not show it.** `POST /cart/price` and
`GET /cart` never ask for an email, and eligibility depends on one — adding an
email parameter would turn the basket into an oracle for "has this address
ordered from you before", which is not a question a public endpoint should
answer about anybody. So the reduction appears once, at checkout.

Two consequences for the UI:

- The cart page cannot promise the discount, only the banner can. Design the
  cart summary without a discount line.
- The checkout summary needs a discount line the current design does not have.
  `discountMinor > 0` is the signal to render it.

Shipping is quoted on the **pre-discount** subtotal, so a promotion can never
push a basket back under the free-shipping threshold and cost the buyer
delivery. Tax is charged on the discounted amount.

`contactPhone` is optional and is the delivery contact — it goes to the courier
as the SMS tracking number. Send it in international form (`+233…` or `00233…`;
spaces, dashes and brackets are fine and get stripped). A bare national number
is rejected rather than guessed at from the shipping country, because a
plausible wrong number is worse than an absent one.

Unlike `contactEmail`, it **is** honoured for a signed-in buyer: an email
address identifies the account and cannot be overridden from a request body,
but a phone number is just where the courier calls, and someone shipping a gift
should be able to give the recipient's. A signed-in buyer who sends none gets
the number from their profile.

### 4. Store the token before navigating away

> **`accessToken` is returned exactly once** and is the only credential that can
> reach this order without an account. Only a hash of it is stored server-side,
> so it cannot be re-sent — not by support, not by the backend. Persist it
> *before* sending the user to Stripe, or a mid-payment crash loses the order
> for them permanently.

Key it by `reference`. The confirmation email should also carry a tracking link
built from both — email is what survives a cleared browser or a new device.


**A confirmation email now carries this too**, for guests only — so a shopper who
closes the tab is no longer locked out of their own order. It arrives when
payment lands, not at checkout, and prints the code as text rather than a link:
a token in a URL leaks through Referer headers, browser history and any
analytics on the landing page.

That is a safety net, not a substitute. Still store the token client-side —
email is slower than the confirmation screen and sometimes never arrives.

### 5. Send to Stripe, then confirm

Open `url`. When the user returns, confirm with `POST /api/v1/orders/lookup`
using the reference and token — do not trust the return URL alone, as the
payment webhook may not have landed yet.

```jsonc
// POST /api/v1/orders/lookup   (no auth)
{ "reference": "ORD-7K2M9QX4", "token": "v4Xk9..." }
```

### 6. Build "Track My Order" on the short code

The reference-plus-token pair above is right for *your* code, which still has
both to hand. It is wrong for a customer typing into a form: the token is 43
characters and they no longer have it.

Every order also carries `trackingCode` — eight characters, e.g. `7K2M9QX4`,
printed on the confirmation email. Pair it with the email address the order was
placed with:

```jsonc
// POST /api/v1/orders/track   (no auth)
{ "code": "7K2M9QX4", "email": "rachel@example.com" }
```

Both fields are required, and **the form must ask for both**. The code is short
enough to type, which makes it short enough to guess; the email is what stops a
guessed code opening somebody else's order. It is an identifier, not a password.

Send the code exactly as the customer typed it — case is ignored, and spaces and
dashes are stripped server-side.

This works for signed-in customers too, and is not scoped to the caller, so the
same screen serves everyone. A `404` covers both an unknown code and a wrong
email and is deliberately indistinguishable: show one "we couldn't find that
order" state rather than trying to tell the user which half was wrong.

Do not confuse `trackingCode` with `trackingNumber`. The first is ours and
exists from the moment the order is placed, so it tracks an order that has not
shipped yet. The second is the carrier's, arrives with the dispatch, and is null
until the parcel actually moves — along with `carrier`, `trackingUrl` and
`dispatchedAt`. All four being null is the normal state of a new order, not an
error.

### 7. Offer the account, then claim

On the confirmation screen ("Save your order details"): sign the user up, then
call `POST /api/v1/orders/claim` with the same reference and token, this time
with a bearer token. The order moves into their history and the access token is
retired — claiming is single-use.

If they skip it nothing breaks; the token keeps working for tracking.

## Currency

`currency` is optional on `/cart/price`, `/cart/checkout` and `GET /cart`, and
it works identically whether or not the caller is signed in. When omitted the
server resolves it in three steps:

1. The `currency` you sent — **only if it is one of the supported currencies**
2. Otherwise, the currency mapped to the destination country
3. Otherwise, `DEFAULT_CURRENCY`

Currently: supported is `USD, GBP, EUR`; the country map covers `GB → GBP` and
the eurozone; the default is **USD**. So an order shipping to Ghana with no
`currency` is priced in USD, not GHS.

> **An unsupported currency is ignored, not rejected.** Sending
> `"currency": "GHS"` returns `200` priced in something else. Always read
> `currency` back off the response rather than assuming your override took.

## Buying while signed in

The cart is server-side. Use `POST /api/v1/cart/items`, `PATCH` and `DELETE` on
`/api/v1/cart/items/:bookId`, and `GET /api/v1/cart`, all with the bearer token.

At checkout send only the address and (optionally) currency — **no `lines`**,
because the stored cart is authoritative and lines are ignored. `contactEmail`
is ignored too; the account email always wins.

```jsonc
// POST /api/v1/cart/checkout   (bearer token)
{
  "shippingAddress": {
    "name": "Rachel TM",
    "line1": "19 H P Nyemitei St",
    "city": "Accra",
    "postcode": "GZ-188-608",
    "countryCode": "GH"
  },
  "currency": "GBP"          // optional, exactly as for a guest
}
```

Only `lines` and `contactEmail` behave differently by auth state. Everything
else — including `currency` and `contactPhone` — is identical for both.

### The handover at sign-in

When a guest with a local basket signs in or signs up, the client must replay
each line into the stored cart with `POST /api/v1/cart/items`, then clear its
local copy. **There is no server-side merge.** If this is skipped, the user's
basket appears to empty on login.

## Filtering the shop

`GET /books?shoppable=true` takes the filter set the shop's Filters panel needs:

| Param | Notes |
| --- | --- |
| `isbn` | ISBN-13, exact. Hyphens and spaces are stripped, so the number as printed works. |
| `yearMin` / `yearMax` | Publication year, inclusive both ends. Undated books drop out of a year-filtered result. |
| `priceMin` / `priceMax` | **Major units** — `20` means $20, not 2000 cents. Requires `shoppable=true`. |
| `currency` | Which currency the price bounds are in. Defaults to the currency this request would be quoted in. |
| `sortBy` | `title` or `newest`. Pair with `sort=asc\|desc` for direction. |

### `shoppable=true` orders the page — it does not filter it

Three bands, in this order:

| Band | Rows | Fields |
| --- | --- | --- |
| In stock | `shoppable: true`, `inStock: true` | Full price fields. Buy now. |
| Orderable, unstocked | `shoppable: true`, `inStock: false` | Full price fields. Out-of-stock treatment; the extended catalogue and print-on-demand titles live here and take longer to arrive. |
| Unsellable | `shoppable: false` | **No price, no `inStock`.** No ISBN13, no live price, or a supplier code saying it cannot be supplied. Never give these an Add button. |

Nothing is excluded, so `shoppable=true` and `shoppable=false` return the same
books in a different order, and `total` is the whole filtered catalogue either
way. **If the shop wants only sellable books, stop at the first
`shoppable: false` rather than paginating to `total`.**

It ranks rather than filters because a catalogue that changes size with a query
parameter cannot be paged through consistently — and stock in particular moves
hourly, so a book vanishing mid-browse reads as a bug.

`priceMin`/`priceMax` are unaffected and still filter: a price range is a
request for a shelf, not an ordering. Because an unsellable book has no price,
a price-filtered page contains no unsellable rows at all.

Sellable rows also carry the **live price** — `unitPriceMinor`,
`compareAtMinor` (null when not on sale) and `currency`. Render those.

**Ignore the `prices` array on a shop surface.** It is ONIX edition metadata,
it is GBP-only, and it disagrees with the live supplier feed on about 2% of the
catalogue — so a listing built from it will occasionally advertise a price the
basket refuses to honour. `unitPriceMinor` is the same number the price filter
matches on and the same number the cart will quote.

Three things worth knowing before wiring the panel up:

- **Price bounds without `shoppable=true` are a 400, not an unfiltered page.**
  The price lives on the supplier row that only the shoppable path consults, and
  a filter that quietly did nothing would be invisible from the client.
- **The price boundary is approximate by up to a penny.** The displayed price is
  converted out of GBP with a rounding buffer, so converting the bound back
  cannot be exact. Both ends are treated as inclusive, which means a book may
  appear one penny outside the range rather than a matching book being hidden.
- **`sortBy` is ignored whenever `q` is set.** Search results are ranked by
  relevance, and reordering that ranking by title gives you neither. If the
  panel offers both a search box and a sort, expect sort to have no effect while
  a query is present — that is deliberate, not a bug.

There is **no price sort**. Ordering on the supplier price means evaluating a
correlated subquery for every candidate row before the page limit applies, which
is the shape that has bitten this endpoint before. It needs measuring against
the real table first.

## `shoppable` applies to the feeds too, and is off by default

Every discovery feed takes the same `shoppable=true` flag as `GET /books`:

| Endpoint | Where it appears |
| --- | --- |
| `GET /explore/trending` | Homepage "Trending Now" |
| `GET /explore/personalized` | Personalised recommendations |
| `GET /books/:id/similar` | PDP "You may also like" |
| `GET /books/recommendations` | Cart "You may also like" |

Passing it also puts `unitPriceMinor`, `compareAtMinor`, `currency` and
`inStock` on every row, exactly as on `GET /books` — so a carousel with an Add
button needs no second request to price what it is showing.

**The price is never cached, though the feed is.** These feeds cache their pool
for an hour; the price is attached after the cache read, on every request. So a
supplier price change is visible immediately while the *ordering* may be up to
an hour old. That split is deliberate: stale ordering is invisible, a stale
price is a customer seeing one number on the shelf and another in the basket.

**Pass `true` from any surface that renders an Add button.** These feeds default
to `false` for backward compatibility, so a client that forgets will show books
the cart then refuses — a button that cannot work.

`GET /explore/bestsellers` is the exception: it ranks by what people actually
bought, and silently dropping an unsellable title would leave a "top 10" showing
seven. Those results are hydrated with the same availability fields, so render
the state rather than removing the row.

Withdrawn titles are now excluded from every feed regardless of the flag.

## Three availability states, not two

A book is not simply in stock or out of it. Roughly 40% of the catalogue is
**supplied to order** — Gardners' extended catalogue and print-on-demand titles,
which they never hold stock of but will always order in.

| State | Signal | What to show |
| --- | --- | --- |
| In stock | `supplyToOrder: false`, stock above zero | Normal card, normal buy button |
| **Supplied to order** | `supplyToOrder: true` | "Available to order" — buyable, **not** an out-of-stock badge. Expect a longer lead time. |
| Out of stock | `supplyToOrder: false`, `unavailableReason: "out_of_stock"` | The out-of-stock treatment |

A supply-to-order title legitimately reports `stockQty: 0`. **Do not gate the
buy button on that number** — use `availableQuantity` on `POST /cart/price`, or
simply the absence of `unavailable`. Showing an out-of-stock badge on these
would mislabel a large part of the shop as unbuyable.

`supplyToOrder` appears on cart lines, `POST /cart/price` lines, and saved books.

## Out of stock is a state to render, not a reason to hide

A book that is out of stock **stays in every response** and is flagged rather
than dropped. This is deliberate: supplier stock moves hourly, and a title
vanishing from the catalogue mid-browse reads as a bug, where a visible
"out of stock" state reads as a shop. The Figma has a design for this state —
build it rather than filtering these books out client-side.

Three places carry the signal, and they mean slightly different things:

| Where | Field | Meaning |
| --- | --- | --- |
| `GET /books?shoppable=true` | `inStock: false` | Listed and priced, but not in stock right now. Show the card with the out-of-stock treatment; do not remove it. Only ever present on rows with `shoppable: true`. |
| `GET /books?shoppable=true` | `shoppable: false` | Cannot be sold at all, and sorted to the end of the listing. No price, no `inStock`, no Add button. |
| `POST /cart/price` | `availableQuantity` < `quantity` | Partial stock. They asked for 3, we can ship 2. Say so rather than silently reducing the stepper. |
| `POST /cart/price` | `unavailable: true` + `unavailableReason` | Cannot be bought at all right now. `out_of_stock` is temporary; `unsuppliable`, `no_price` and `market_restricted` are not. |
| `GET /saved-books` | `inStock`, `unavailable` | Same treatment. A saved book that has become unbuyable is kept and flagged so it never silently disappears from someone's list. |

Two consequences worth designing for:

- **An out-of-stock line still has a price.** `unitPriceMinor` is populated, so
  the card renders normally — it is the buy action that changes, not the layout.
- **Totals already exclude what cannot ship.** `subtotalMinor` and `itemCount`
  on `POST /cart/price` count only sellable quantity, so a basket containing an
  out-of-stock line will show a total lower than the line prices suggest. That
  is intentional; showing a total that includes unshippable copies sets up a
  surprise at checkout.

`shoppable=true` does return books that are permanently unsellable — it sinks
them to the end of the listing rather than dropping them, and marks each one
`shoppable: false` with no price and no `inStock`. That flag is the one to gate
the Add button on; `inStock` is about *temporary* unavailability and only
appears on rows that are sellable in the first place.

## Errors worth handling explicitly

| Code | Status | What to do |
| --- | --- | --- |
| `CART_CHANGED` | 409 | **Expected, not an error.** A price or stock level moved. The body carries `changes`, and a signed-in user's cart has already been repaired. Show what changed and let them retry — the retry succeeds. |
| `LINES_REQUIRED` | 400 | Guest checkout with no basket in the body. Send `lines`. |
| `EMAIL_REQUIRED` | 400 | Guest checkout with no `contactEmail`. There is no account to read one from. |
| `CART_TOO_LARGE` | 400 | Too many distinct titles. Cap the basket client-side to match `CART_MAX_ITEMS`. |
| `COUNTRY_NOT_SUPPORTED` | 409 | We cannot ship there. Surface it at the address step, not after payment. |
| — | 404 | On lookup or claim: unknown reference, wrong token, or already claimed — deliberately indistinguishable. Show one "we couldn't find that order" state; do not try to tell them apart. |
| — | 429 | Lookup and claim allow 10 per 15 minutes per IP. A person retyping will not hit it. |

## Five things that catch people out

1. **All money is integer minor units.** `totalMinor: 3497` is $34.97, never
   $3,497. There are no decimals anywhere in the API, and the unit is the minor
   unit of whatever `currency` the response reports — not always the one you
   asked for.
2. **Render a struck-through price only when `compareAtMinor` is non-null.** It
   is the price being marked down *from*, and it is absent unless a sale
   genuinely reduces the price.
3. **Bucket order status on `statusBucket`, not `status`.** The raw status has
   eleven values and may gain more; `statusBucket` is the stable four
   (`pending`, `in_progress`, `delivered`, `closed`) that the order tabs map to.
4. **Null tracking fields are normal.** `carrier`, `trackingNumber` and
   `trackingUrl` stay null until the parcel physically ships. That is a "being
   prepared" state, not a failure.
5. **A local basket does not follow the user to another device** until they sign
   in. That is by design — do not promise cross-device baskets to guests.

## Endpoint summary

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/v1/cart/price` | none |
| `POST` | `/api/v1/cart/checkout` | optional |
| `GET` | `/api/v1/cart` | required |
| `POST` | `/api/v1/cart/items` | required |
| `PATCH` | `/api/v1/cart/items/:bookId` | required |
| `DELETE` | `/api/v1/cart/items/:bookId` | required |
| `DELETE` | `/api/v1/cart` | required |
| `GET` | `/api/v1/orders?status=` | required |
| `GET` | `/api/v1/orders/:id` | required |
| `POST` | `/api/v1/orders/lookup` | none |
| `POST` | `/api/v1/orders/track` | none |
| `POST` | `/api/v1/orders/claim` | required |
| `GET` | `/api/v1/books?shoppable=true` | none |
| `GET` | `/api/v1/books/:id/similar` | optional |
| `GET` | `/api/v1/saved-books` | required |
| `POST` | `/api/v1/saved-books` | required |
| `DELETE` | `/api/v1/saved-books/:bookId` | required |
| `GET` | `/api/v1/books/recommendations` | optional |

### Saved Books follows the same rule as the basket

Nothing is stored for a signed-out visitor. Keep saved books on the device and
replay them into `POST /api/v1/saved-books` after sign-in, then clear the local
copy — exactly as with the basket. There is no server-side merge.
