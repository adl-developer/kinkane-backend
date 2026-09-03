# Delivery options at checkout — client integration brief

**Audience:** whoever builds the cart and checkout screens in the Kinkané apps.
**Status:** the API is live; the pricing behind it is behind a server-side flag
that is currently off. Read "Two phases" below before estimating the work.

This document is self-contained. Everything you need to integrate is here.

---

## 1. What is changing, and why

Kinkané does not hold stock. Orders are passed to Gardners, a UK wholesaler, who
ship directly to the customer. Gardners offer several delivery services, and the
price difference between them is large.

For a single paperback (about 400g) to Ghana:

| Service | What Gardners charge us |
| --- | --- |
| Standard international (untracked) | £8.45 |
| Tracked international | £32.52 |

Until now the app sent **every** overseas order tracked, and charged a flat
£11.99 for it. Two problems: the customer was never asked whether they wanted to
pay for tracking, and we lost about £21 on each of those orders.

The fix is a delivery chooser. The server now prices each available service for
the specific basket and destination, and the customer picks. **That chooser is
the screen you need to build.**

---

## 2. The flow

```
  Cart screen                 Delivery step               Payment
  ───────────                 ─────────────               ───────
  GET /api/v1/cart       →    POST /api/v1/cart/      →   POST /api/v1/cart/
  (or /cart/price)            shipping-options            checkout
                                                          → open Stripe URL
  shows an ESTIMATE           customer picks one          send the chosen
  (cheapest option)           serviceCode                 serviceCode
```

1. The cart shows an **estimate** — it does not know the destination yet, so it
   guesses from the viewer's approximate location.
2. Once you know the delivery country, call `shipping-options` to get real
   prices for this basket.
3. The customer picks one. You send its `serviceCode` to checkout.
4. Checkout re-prices from that code and returns a Stripe URL.

The cart total and the checkout total can legitimately differ. Label the cart
figure as an estimate.

---

## 3. Money format — read this first

**Every amount in these APIs is an integer in the minor unit of its currency.**

- `915` in GBP is **£9.15**, not £915.
- `3322` in GBP is **£33.22**.
- Some currencies have no minor unit. In JPY, `915` is ¥915.

Divide by 100 for GBP/USD/EUR. Never render a raw value. Never do money
arithmetic in floating point — add the integers, then format once.

Fields ending `Minor` are in the **customer's** currency (whatever `currency`
says in the same response). Fields ending `GbpPence` are always GBP pence and
are for logging and support, not for display.

---

## 4. `POST /api/v1/cart/shipping-options`

Prices every delivery service that can carry this basket to this country.
Stores nothing. No authentication required, but works signed in.

### Request

```json
{
  "countryCode": "GH",
  "lines": [
    { "bookId": 48213, "quantity": 1 },
    { "bookId": 51002, "quantity": 2 }
  ],
  "currency": "GBP"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `countryCode` | **yes** | ISO-3166 alpha-2, case-insensitive. The delivery destination. |
| `lines` | for guests | Book ids and quantities only. A signed-in caller may omit it to price their stored cart. |
| `currency` | no | ISO-4217 override. Silently ignored if unsupported — read `currency` off the response. |

There is deliberately no price field. Everything is priced from server data, so
there is nothing a client can influence.

**The country is never guessed from the caller's IP.** Quoting one country and
charging for another is exactly the failure this endpoint exists to prevent, so
you must pass the real destination.

### Response

```json
{
  "currency": "GBP",
  "options": [
    {
      "serviceCode": "010",
      "label": "Standard international",
      "tracked": false,
      "estimatedDaysMin": 7,
      "estimatedDaysMax": 10,
      "priceMinor": 915,
      "priceGbpPence": 915,
      "recommended": true
    },
    {
      "serviceCode": "011",
      "label": "Tracked international",
      "tracked": true,
      "estimatedDaysMin": 7,
      "estimatedDaysMax": 10,
      "priceMinor": 3322,
      "priceGbpPence": 3322,
      "recommended": false
    }
  ],
  "weightEstimated": false,
  "unavailableReason": null
}
```

| Field | Meaning |
| --- | --- |
| `serviceCode` | Opaque identifier. Send this to checkout. Never send a price. |
| `label` | Display text. Render as-is; do not build your own from the code. |
| `tracked` | Whether the parcel is trackable to the door. Worth a badge or icon. |
| `estimatedDaysMin` / `Max` | Working days, from despatch. Render as a range. |
| `priceMinor` | What to display, in `currency`. |
| `priceGbpPence` | Same figure in GBP pence, for logs. Do not display. |
| `recommended` | Preselect this one. Exactly one option has it, when any do. |

**`options` is sorted cheapest first, and `recommended` is the cheapest — not
the fastest.** On most overseas destinations the tracked upgrade costs more than
the books in the basket, so preselecting tracked would repeat the mistake this
change exists to fix.

### An empty `options` array is a `200`, not an error

Handle it in the cart, before the customer invests effort in checkout.

| `unavailableReason` | What happened | Suggested copy |
| --- | --- | --- |
| `null` | Options are available. | — |
| `country_not_supported` | We cannot address a parcel to that country at all. | "We can't deliver to {country} yet." |
| `no_service` | We can deliver there, but nothing available carries this particular basket — almost always a basket too heavy for the only service that serves that country. Untracked airmail stops at 2kg; tracked runs to 30kg. | "This order is too large to deliver to {country}. Try removing an item." |

### `weightEstimated`

`true` when a book in the basket had no recorded weight and the server assumed
one. **The price is still binding** — this is not a warning to the customer.
It exists for support triage. Do not surface it in the UI.

### Errors

| Response | When |
| --- | --- |
| `400` (field errors) | `countryCode` not exactly 2 characters, or malformed `lines` |
| `400` `INVALID_COUNTRY` | Two letters, but not a real country code |
| `400` `CART_EMPTY` | A guest sent no `lines`, or a signed-in caller's cart is empty |

Note the asymmetry: an unshippable *destination* is a `200` carrying
`unavailableReason`. Only a malformed *request* is a 4xx.

---

## 5. `POST /api/v1/cart/checkout`

Unchanged except for one new optional field. Full body:

```json
{
  "shippingAddress": {
    "name": "Ama Mensah",
    "line1": "24 Cantonments Road",
    "line2": "Cantonments",
    "city": "Accra",
    "region": "Greater Accra",
    "postcode": "GA-123-4567",
    "countryCode": "GH"
  },
  "shippingCountry": "GH",
  "currency": "GBP",
  "contactEmail": "ama@example.com",
  "contactPhone": "+233244123456",
  "shippingServiceCode": "010",
  "lines": [{ "bookId": 48213, "quantity": 2 }]
}
```

| Field | Notes |
| --- | --- |
| `shippingAddress` | Preferred. Its `countryCode` **is** the destination, and Stripe then collects payment only. Required sub-fields: `name`, `line1`, `city`, `postcode`, `countryCode`. |
| `shippingCountry` | The older flow — Stripe collects the address, locked to this country. Send this **or** `shippingAddress`; one of the two is required. |
| `currency` | Optional override. Ignored if unsupported. |
| `contactEmail` | **Guests only** — required for them. Ignored for signed-in buyers, whose account email always wins. |
| `contactPhone` | Honoured for everyone. Someone shipping a gift can give the recipient's number without editing their own profile. |
| `shippingServiceCode` | **New.** Three-digit string from `shipping-options`. |
| `lines` | **Guests only** — required for them, ignored for signed-in buyers. |

### About `shippingServiceCode`

- Send the `serviceCode` of the option the customer selected. Nothing else —
  the server re-prices it and will not accept a price from a client.
- **Omitting it selects the cheapest available service.** So a build that has
  not yet added the chooser behaves safely rather than upgrading everyone to
  tracked. You can ship the rest of your work before the chooser.
- A code that does not serve the destination returns **`400`
  `SHIPPING_SERVICE_UNAVAILABLE`**. This is deliberate: the customer is looking
  at a price for a service they chose, so charging them for a different one
  silently is the worst possible outcome. Re-fetch the options and ask again.

### Errors worth handling

| Response | Meaning | What to do |
| --- | --- | --- |
| `400` `SHIPPING_SERVICE_UNAVAILABLE` | The chosen service doesn't serve that destination. | Re-fetch options, ask again. |
| `409` `CART_CHANGED` | A price or stock level moved. Body carries a `changes` array; the stored cart has already been repaired. | Show what changed, let them press the button again. This is a normal path, not a failure. |
| `409` `COUNTRY_NOT_SUPPORTED` | We cannot ship there. | Same copy as `country_not_supported` above. |
| `400` `EMAIL_REQUIRED` | Guest sent no `contactEmail`. | — |
| `400` `LINES_REQUIRED` | Guest sent no `lines`. | — |

---

## 6. The cart endpoints

`GET /api/v1/cart` (signed in) and `POST /api/v1/cart/price` (basket in the
request, nothing stored) are **unchanged in shape**. One field changes meaning:

`estimatedShippingMinor` now reflects the **cheapest available delivery
option** rather than a flat regional rate. It is the same figure that
`shipping-options` will mark `recommended`, assuming the same destination.

It is `null` when the server cannot guess the viewer's country. Render
"Calculated at checkout" rather than zero — showing free delivery and then
charging £9 is a conversion killer and a support ticket.

Because the cart guesses the country and the delivery step knows it, the two
figures can differ. **Label the cart figure as an estimate.**

---

## 7. The services you may see

You should never hardcode this list — always render what the API returns — but
it helps to know the shape of it.

| Code | Label | Tracked | Typical speed | Where |
| --- | --- | --- | --- | --- |
| `001` | Standard delivery | No | 2–3 working days | UK |
| `002` | Next-day delivery | No | 1–2 working days | UK |
| `010` | Standard international | No | 5–7 days W. Europe, 7–10 elsewhere | Overseas |
| `011` | Tracked international | Yes | 5–7 days W. Europe, 7–10 elsewhere | Overseas |

**Coverage is uneven and server-owned.** Some countries offer only tracked, some
only untracked, and a handful we can address have no published rate at all and
cannot be shipped to. This is data on our side that changes when our supplier
reissues their price sheets — which is why a hardcoded picker will be wrong
within months.

---

## 8. Two phases — what you will actually see today

The weight-based pricing sits behind a server flag that is **currently off**
while the rates are validated. The API is identical either way, but the data
differs, so build for both.

**Today (flag off).** `shipping-options` returns **exactly one** option — the
service the order would actually ship by, at the current flat rate. The chooser
should render it as a single row, or collapse to a plain line item.

**After the flag flips.** Real per-service prices appear, and most overseas
destinations return two options with a large gap between them.

A chooser that renders whatever the array contains — one row or three — works in
both phases with no client release in between. Do not special-case a length of
one by hiding the section entirely; the price still needs showing.

---

## 9. Test destinations

Useful cases while building, once the flag is on:

| Country | Why it's interesting |
| --- | --- |
| `GH` Ghana | Two options with a large gap. The main case. |
| `GB` United Kingdom | Two domestic speeds, both cheap. |
| `UG` Uganda | Tracked only — a single option. |
| `TZ` Tanzania | Untracked only — a single option. |
| `DE` Germany | EU. Carries a customs surcharge in the price. |
| `ET` Ethiopia | No published rate. Returns `country_not_supported`. |

For `no_service`, put five heavy books in a basket to a country served only by
untracked airmail — the 2kg ceiling is what trips it.

---

## 10. Checklist

- [ ] Cart shows `estimatedShippingMinor` labelled as an estimate, and
      "Calculated at checkout" when it is `null`.
- [ ] Delivery step calls `shipping-options` with the real destination country.
- [ ] Options render from the array, sorted as returned, with `recommended`
      preselected.
- [ ] `tracked` is visible to the customer — it is what they are paying for.
- [ ] Empty `options` handled for both `unavailableReason` values.
- [ ] Chosen `serviceCode` passed to checkout; no price ever sent.
- [ ] `400 SHIPPING_SERVICE_UNAVAILABLE` re-fetches options.
- [ ] `409 CART_CHANGED` shows the changes and allows a retry.
- [ ] All amounts divided by 100 before display; no float arithmetic.
- [ ] One option and several options both render correctly.
