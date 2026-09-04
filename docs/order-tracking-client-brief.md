# Orders and order tracking — mobile client brief

**Audience:** whoever builds the checkout confirmation, order history and
"Track My Order" screens in the Kinkané apps.
**Status:** live on `main` as of 2026-09-04. The short tracking code is new;
everything else described here already shipped.

This document is self-contained. It restates what you need from the wider shop
integration guide so you do not have to read that first.

Field-by-field contracts live in the OpenAPI spec at `GET /openapi.json`
(Swagger UI on the same host). **Where this document and the spec disagree, the
spec is correct** — it is generated from the running code.

---

## 1. The mental model: two identifiers and one credential

Almost every mistake made against this API comes from treating these three
strings as interchangeable. They are not. Read this section before writing any
code.

| String | Example | What it is | Secret? |
| --- | --- | --- | --- |
| `reference` | `ORD-7K2M9QX4` | The order's name. Printed on receipts, quoted in support, safe to show anywhere. | **No** |
| `trackingCode` | `7K2M9QX4` | Short code the customer types to track an order. Ours, not the carrier's. | **No** |
| `accessToken` | `v4Xk9…` (43 chars) | The credential that proves a guest owns the order. Returned **once**, at checkout. | **Yes** |

The two identifiers are random rather than sequential, so nobody can walk the
order book by incrementing a number. But random is not the same as secret:
either can end up in a screenshot or a support ticket, so **neither is ever
enough on its own** to read an order.

That gives three ways into an order, and they are for three different
situations:

| Situation | Call | Auth |
| --- | --- | --- |
| Signed-in customer browsing their own orders | `GET /orders`, `GET /orders/:id` | Bearer token |
| Your code, right after checkout, still holding the access token | `POST /orders/lookup` | reference + accessToken |
| A human typing into a form | `POST /orders/track` | trackingCode + email |

A fourth call, `POST /orders/claim`, is not a read at all — it transfers
ownership of a guest order to an account. See §7.

### Why the tracking code needs the email

Eight characters is short enough for a customer to read off their phone and
type into a form. That is the entire point of it — and it is also why it cannot
be the only thing you send. A code that short is guessable given enough
attempts, so the email address the order was placed with is the second factor.

**Do not build a screen that submits the code alone.** There is no endpoint that
would accept it, and asking for the email is not friction to be optimised away —
it is what stops a stranger reading a customer's name, address and purchases.

---

## 2. Two tracking fields, and they are not the same thing

The order object carries both. Confusing them is the single most likely bug on
the tracking screen.

| Field | Whose | Exists when | Example |
| --- | --- | --- | --- |
| `trackingCode` | **Ours** | From the moment the order is placed | `7K2M9QX4` |
| `trackingNumber` | The carrier's (Royal Mail etc.) | Only once the parcel physically ships | `AB123456789GB` |

`trackingCode` is what the customer types to find their order. It works
immediately, including while the order is still being prepared — which is
exactly when an anxious customer goes looking for it.

`trackingNumber` is what they hand to Royal Mail's own site. It arrives when our
supplier reports the dispatch, along with `carrier`, `trackingUrl` and
`dispatchedAt`.

> **All four carrier fields being `null` is the normal state of a new order, not
> an error.** Design the tracking screen so a paid-but-not-yet-shipped order
> looks correct and complete, not broken. This is where most orders will spend
> their first day or two.

---

## 3. Placing an order (the short version)

Full detail is in `docs/shop-integration.md`; this is what matters for tracking.

A guest checks out with `POST /api/v1/cart/checkout`, sending `lines`,
`contactEmail` and a shipping address. The response is the only time you will
ever see the access token:

```jsonc
// 200
{
  "url": "https://checkout.stripe.com/c/pay/...",
  "orderId": 1042,
  "reference": "ORD-7K2M9QX4",
  "accessToken": "v4Xk9...",   // returned ONCE — persist before navigating away
  "currency": "GBP",
  "totalMinor": 2997
}
```

> **Persist `accessToken` before you send the user to Stripe.** Only a hash is
> stored server-side, so it cannot be re-issued — not by support, not by the
> backend. A mid-payment crash with an unsaved token loses that order for the
> customer permanently. Key it by `reference`.

Signed-in buyers use the server-side cart and send no `lines`; `contactEmail` is
ignored because the account email always wins.

Then open `url`. When the user comes back, **do not trust the return URL** — the
payment webhook may not have landed. Confirm with `GET /api/v1/payments/{reference}`
and branch on the boolean `paid`. That endpoint falls back to asking Stripe
directly while the payment is still pending, so the first call usually gets a
definitive answer.

---

## 4. The tracking endpoint

```jsonc
// POST /api/v1/orders/track     (no auth)
{
  "code": "7K2M9QX4",
  "email": "rachel@example.com"
}
```

Returns `200` with the full order object (§5).

**Both fields are required.** Send the code exactly as the customer typed it —
case is ignored, and spaces and dashes are stripped server-side, so `7k2m-9qx4`
and `7K2M 9QX4` both work. Do not build a masked or segmented input that fights
the customer over formatting; a plain text field is correct.

The email is matched case-insensitively and trimmed, but is otherwise exact.
`rachel+shop@gmail.com` will **not** open an order placed with
`rachel@gmail.com` — that is deliberate, not a bug to work around.

### Works for signed-in customers too

This endpoint is **not scoped to the caller**. A signed-in customer can track an
order that belongs to a different account — for instance one placed for them by
a colleague, or read off a printed slip. Build one tracking screen and use it
for everybody; do not hide it behind a signed-out state.

Signed-in customers still get their own order list via `GET /orders`, which is
the better path when they simply want to see their own history.

### Errors

| Status | Meaning | What to show |
| --- | --- | --- |
| `400` | Malformed code or email | Field-level validation message |
| `404` | Unknown code **or** wrong email | One "we couldn't find that order" state |
| `429` | Rate limited: 10 per 15 min per IP | "Too many attempts, try again shortly" |

> The `404` is deliberately identical for an unknown code and a mismatched
> email, so the endpoint cannot be used to discover which codes exist. **Do not
> try to tell the user which half was wrong** — you cannot, and guessing at it
> in the copy ("check your code") will send people down the wrong path half the
> time. Say both: "Check the code and the email address you ordered with."

The rate limit is what makes guessing a short code impractical, so it is
deliberately tight. A customer retyping a code will never hit it; a script will.
Do not retry automatically on `429`.

---

## 5. The order object

Returned identically by `POST /orders/track`, `POST /orders/lookup`,
`GET /orders/:id`, and each row of `GET /orders` — the list carries full `items`
too, so an order history screen needs no follow-up request per row.

```jsonc
{
  "id": 1042,
  "reference": "ORD-7K2M9QX4",
  "trackingCode": "7K2M9QX4",
  "status": "dispatched",
  "statusBucket": "in_progress",

  // Carrier tracking — all null until the parcel ships
  "carrier": "Royal Mail",
  "trackingNumber": "AB123456789GB",
  "trackingUrl": "https://...",
  "dispatchedAt": "2026-09-05T09:12:00Z",
  "deliveredAt": null,

  // Money. All amounts are MINOR units (pence/cents), never decimals.
  "currency": "GBP",
  "subtotalMinor": 2598,
  "discountMinor": 0,
  "discountReason": null,      // e.g. "first_order"
  "shippingMinor": 399,
  "taxMinor": 0,
  "totalMinor": 2997,

  "itemCount": 2,
  "placedAt": "2026-09-04T18:03:00Z",
  "paidAt": "2026-09-04T18:04:12Z",
  "shippingCountryCode": "GH",
  "contactPhone": "+233201234567",

  "items": [{
    "bookId": 48213,
    "isbn13": "9780241984994",
    "title": "Girl, Woman, Other",
    "contributor": "Bernardine Evaristo",
    "quantity": 2,
    "unitPriceMinor": 1299,
    "lineTotalMinor": 2598
  }]
}
```

Two things worth knowing:

- **Line titles and contributors are snapshots** taken at purchase, not live
  joins. A receipt still reads correctly after the catalogue row is re-ingested.
- **The totals always reconcile:**
  `subtotalMinor - discountMinor + shippingMinor + taxMinor === totalMinor`.

---

## 6. Status, and what to render

`status` is the precise internal state. `statusBucket` is that collapsed for
display, and **it is what you should drive UI off** — new `status` values may be
added, while the four buckets are stable.

| `status` | `statusBucket` | Plain meaning |
| --- | --- | --- |
| `pending_payment` | `pending` | Checkout started, not paid. Never appears in `GET /orders`. |
| `payment_failed` | `closed` | Payment did not go through |
| `expired` | `closed` | Checkout abandoned; swept after ~25h |
| `paid` | `in_progress` | Paid, not yet sent to the supplier |
| `submitted_to_supplier` | `in_progress` | Order file sent to Gardners |
| `acknowledged` | `in_progress` | Gardners accepted it |
| `supplier_rejected` | `closed` | Gardners cannot supply it |
| `dispatched` | `in_progress` | Shipped — carrier fields now populated |
| `delivered` | `delivered` | Arrived |
| `refunded` | `closed` | Refunded |
| `cancelled` | `closed` | Cancelled |

`GET /orders?status=in_progress|delivered|closed` filters to the order UI's
tabs. The "All" tab may send no value, an empty string, or the literal `all` —
all three drop the filter rather than erroring.

**`GET /orders` never lists checkouts that were never completed.** An abandoned
Stripe session is not something a customer thinks of as an order, and showing it
reads as a billing error.

### Suggested customer-facing wording

The internal ladder is more granular than a customer needs. Three states carry
it, and the supplier steps are invisible to them:

| Buckets | Customer sees |
| --- | --- |
| `paid`, `submitted_to_supplier`, `acknowledged` | "Preparing your order" |
| `dispatched` | "On its way" + carrier tracking, if `trackingNumber` is present |
| `delivered` | "Delivered" |
| anything `closed` | The specific outcome — refunded, cancelled, could not be supplied |

Do not surface `submitted_to_supplier` or `acknowledged` as distinct customer
states. They tell a customer nothing they can act on and expose that we do not
hold stock ourselves.

---

## 7. Guest orders: lookup and claim

Two endpoints still take the long access token, and both are still needed.

### `POST /orders/lookup` — your code's read path

```jsonc
{ "reference": "ORD-7K2M9QX4", "token": "v4Xk9..." }
```

Use this where **your code** holds the token — chiefly the confirmation screen
straight after checkout. It authenticates with 256 bits rather than eight
characters, so it is the stronger path when you have the option.

Anything this can read, `POST /orders/track` can also read, since you have the
customer's email at checkout too. The difference is strength of proof, not
capability. Rule of thumb: **`/lookup` where your app is the caller, `/track`
where a human is typing.**

### `POST /orders/claim` — attaching a guest order to an account

```jsonc
// Requires a bearer token AS WELL as the body
{ "reference": "ORD-7K2M9QX4", "token": "v4Xk9..." }
```

This is the "Save your order details" step: sign the user up, then claim the
order so it appears in their history.

**This one genuinely requires the access token and always will.** It is a write
that transfers ownership permanently. If it accepted code plus email, anyone who
guessed a code and knew the buyer's address could pull someone else's order into
their own account. That is precisely the attack the token exists to prevent.

Claiming is **single-use** — the token is retired on success, so a forwarded
confirmation email cannot re-home an order that already has an owner. A second
claim returns `404`, as do an unknown reference and a wrong token.

If the customer skips the account offer, nothing breaks: the token keeps working
for `/lookup`, and the tracking code keeps working for `/track`.

---

## 8. What the customer receives by email

The order confirmation email arrives when **payment lands**, not at checkout.
It contains:

- The order reference, in the subject line, so an inbox search finds it
- **The tracking code**, shown large, for everyone — guest or signed-in
- The access token, printed as text, **for guests only**

The token is never put in a URL. A token in a link leaks through Referer
headers, browser history and any analytics on the landing page. If you build a
deep link into the tracking screen, it may carry the tracking code but **must
not** carry the access token.

Email is a safety net, not a substitute for client-side storage — it is slower
than the confirmation screen and sometimes never arrives.

---

## 9. Common mistakes

- **Building a code-only tracking form.** The email is required. There is no
  endpoint that takes the code alone.
- **Showing "no tracking available" as an error state** for a paid order. Null
  carrier fields are the normal first phase of every order's life.
- **Rendering `trackingNumber` where you meant `trackingCode`.** One is null for
  the first day or two of an order; the other never is.
- **Displaying `status` instead of `statusBucket`.** New status values may be
  added; the buckets are stable.
- **Treating minor units as decimals.** `2997` is £29.97.
- **Trying to distinguish a bad code from a bad email** from the `404`. You
  cannot; the response is identical by design.
- **Auto-retrying on `429`.** The limiter is the security control on a short
  code. Show the message and stop.
- **Losing the access token** by not persisting it before opening the Stripe
  page. It is returned exactly once and can never be re-issued.

---

## 10. Endpoint summary

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/cart/checkout` | optional | Create the order, get the Stripe URL + access token |
| `GET` | `/api/v1/payments/{reference}` | none | Confirm payment landed. 60/min |
| `POST` | `/api/v1/orders/track` | none | **Track by code + email.** 10 per 15 min |
| `POST` | `/api/v1/orders/lookup` | none | Read by reference + access token. 10 per 15 min |
| `POST` | `/api/v1/orders/claim` | **required** | Attach a guest order to the account. 10 per 15 min |
| `GET` | `/api/v1/orders?status=` | required | The signed-in customer's order history |
| `GET` | `/api/v1/orders/:id` | required | One of their orders, with lines |

`GET /orders/:id` is scoped to the owner, and someone else's order returns `404`
rather than `403` — telling a stranger that order 812 exists but is not theirs
is more than they need to know.
