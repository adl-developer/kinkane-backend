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

### 4. Store the token before navigating away

> **`accessToken` is returned exactly once** and is the only credential that can
> reach this order without an account. Only a hash of it is stored server-side,
> so it cannot be re-sent — not by support, not by the backend. Persist it
> *before* sending the user to Stripe, or a mid-payment crash loses the order
> for them permanently.

Key it by `reference`. The confirmation email should also carry a tracking link
built from both — email is what survives a cleared browser or a new device.

### 5. Send to Stripe, then confirm

Open `url`. When the user returns, confirm with `POST /api/v1/orders/lookup`
using the reference and token — do not trust the return URL alone, as the
payment webhook may not have landed yet.

```jsonc
// POST /api/v1/orders/lookup   (no auth)
{ "reference": "ORD-7K2M9QX4", "token": "v4Xk9..." }
```

### 6. Offer the account, then claim

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
else — including `currency` — is identical for both.

### The handover at sign-in

When a guest with a local basket signs in or signs up, the client must replay
each line into the stored cart with `POST /api/v1/cart/items`, then clear its
local copy. **There is no server-side merge.** If this is skipped, the user's
basket appears to empty on login.

## Out of stock is a state to render, not a reason to hide

A book that is out of stock **stays in every response** and is flagged rather
than dropped. This is deliberate: supplier stock moves hourly, and a title
vanishing from the catalogue mid-browse reads as a bug, where a visible
"out of stock" state reads as a shop. The Figma has a design for this state —
build it rather than filtering these books out client-side.

Three places carry the signal, and they mean slightly different things:

| Where | Field | Meaning |
| --- | --- | --- |
| `GET /books?shoppable=true` | `inStock: false` | Listed and priced, but not in stock right now. Show the card with the out-of-stock treatment; do not remove it. |
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

`shoppable=true` never returns books that are permanently unsellable — no ISBN,
no price, or a supplier code saying it cannot be supplied. Those are filtered
out entirely. Only *temporary* unavailability surfaces as a flag.

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
