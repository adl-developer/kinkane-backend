# Book checkout no longer breaks when the return URL is configured without a query string

**Date:** 2026-08-11

## What changed

The Stripe Checkout session for a book order builds its `success_url` and
`cancel_url` by appending the order id to a configured base URL. It did that by
string concatenation:

```ts
success_url: `${config.commerce.orderSuccessUrl}&orderId=${order.id}`,
```

That `&` is only correct if the base URL already contains a `?`. It now goes
through a helper that adds the parameter properly whether or not the URL had a
query string:

```ts
success_url: withQueryParam(config.commerce.orderSuccessUrl, 'orderId', String(order.id)),
```

## Why it happened

The two defaults both carry a query string:

```
${APP_URL}/orders?checkout=success
${APP_URL}/cart?checkout=cancelled
```

so on a default configuration the concatenation produces a valid URL and the
bug is invisible. It only appears once an operator sets `STRIPE_ORDER_SUCCESS_URL`
or `STRIPE_ORDER_CANCEL_URL` to a plain path — the natural thing to do — at
which point the result is:

```
https://kinkane.app/orders&orderId=42
```

`&orderId=42` becomes part of the *path*, not a query parameter. Stripe rejects
the session outright, so the failure is not a subtly wrong redirect after
payment: it is checkout refusing to start at all, for every buyer, with an error
that points at Stripe rather than at our own configuration.

## The helper

`src/lib/url.ts` — `withQueryParam(url, key, value)`. It parses with the `URL`
API and uses `searchParams.set`, which means:

- a base URL with no query string gains one (`?orderId=42`)
- a base URL that already has one gets the parameter appended (`&orderId=42`)
- calling it twice with the same key replaces rather than duplicates
- an unparseable URL throws, rather than silently producing something malformed

The last point is deliberate. A bad redirect target is an operator
misconfiguration, and a loud failure at the point of use is what makes it
findable — the alternative is Stripe rejecting the session and the cause being
two layers away from the error.

## Scope

Only the book-order checkout was affected. The subscription checkout
(`src/services/subscriptions/checkout.service.ts`) passes its success, cancel
and portal-return URLs through unmodified, so it never had this problem.

## Verified

`withQueryParam` exercised directly against all three cases — no query string,
existing query string, and applied twice — confirming the produced URLs are
well-formed and the parameter is never duplicated.
