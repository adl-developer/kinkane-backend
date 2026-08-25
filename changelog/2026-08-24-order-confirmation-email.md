# The order confirmation email

## What changed

When payment lands, whoever bought the books now gets an email: the order
number, what they bought, the totals with the discount broken out, and where it
is going. For a guest it also carries the tracking code.

## Why

There was no order email at all. Seventeen templates — welcome, password reset,
subscription confirmed, trial ending, referral invite — and not one for the
thing that takes money. `receipt_email` is not set on the Stripe session either,
so nothing reached the buyer from any direction.

For a signed-in buyer that was untidy. **For a guest it was a hole.** The
tracking token is handed to the client exactly once, in the checkout response —
`checkout.service` says so directly: *"Returned in the clear here and nowhere
else, ever."* Close the tab and the order became permanently unreachable to the
person who had just paid for it: no reference, no token, no account, no email.
`POST /orders/lookup` and `POST /orders/claim` both need that token, so there
was no route back in at all.

## Getting the token to the email

The email is sent from the paid webhook, minutes after checkout, and by then the
raw token is gone — only its hash is stored, deliberately. So it is parked in
Redis at checkout under `order:guest-token:{orderId}`, read once by the webhook,
and deleted.

The alternatives were all worse:

- **Store it on the order** — undoes the hashing. One database leak then hands
  over every guest order *and* the credential to reach it.
- **Stripe session metadata** — puts a bearer credential in a third party's
  dashboard and logs, permanently.
- **Send at checkout instead** — the order is not paid yet, and most unpaid
  checkouts never become orders.

It expires on its own (26h, just past a Stripe session's life) and losing it is
survivable: the email is simply sent without a tracking section, which is what a
signed-in buyer gets anyway.

## Non-obvious decisions

**The code is printed as text, never as a link.** `checkout.service` says never
to put this token in a URL, and that is right — a token in a link leaks through
Referer headers, browser history and any analytics on the landing page. In an
inbox it is just as durable and leaks nowhere. A test asserts the code never
appears inside a URL in either the HTML or the text part.

**Guests only.** A signed-in buyer sees "You can see this order any time under
My Account" instead. Printing a credential somebody does not need is a
credential that can leak for no reason.

**Not a payment receipt.** Stripe issues those. This follows the reasoning
already written on the subscription-confirmed template — sending a second
receipt trains people to ignore both. This one answers what a receipt does not:
what was bought, where it is going, and how to find it again.

**No "Discount £0.00" line.** It only appears when there was one. A zero
discount on every full-price order invites "why didn't I get one?" from people
who were never eligible.

**Queued at priority 1**, above every other transactional email. Somebody has
just been charged, and for a guest this is the only copy of their tracking code
that will ever exist. It must not sit behind a newsletter.

**The sender never throws.** A webhook that fails because an email could not be
composed gets retried by Stripe, and every retry re-runs the side effects around
it — so a broken email would become duplicate fulfilment attempts. It logs and
gives up instead.

## Verified

End to end against the local database, with the real queue and worker:

1. Guest checkout → `orderId=28`, `ORD-ZK37J6GG`, token returned once.
2. Redis holds the raw token under `order:guest-token:28`.
3. Paid webhook fires → `Order paid` → `Email job completed, jobName: order-confirmed`.
4. Redis no longer holds the token — read once, then destroyed.
5. The code from that email works: `POST /orders/lookup` returns the order,
   `status: paid`.

`src/__tests__/order-confirmed-email.test.ts` covers the rendering: order number
in the subject so an inbox search finds it, every book with author and quantity,
totals that reconcile, the discount line omitted at zero, "Free" rather than
"0.00", the guest code present in both parts and **never inside a URL**, absent
for a signed-in buyer, a title containing markup escaped, and no "Hi null" for a
guest who gave no name.

## Not covered

**No dispatch or delivery email.** Nothing in the system marks an order
dispatched or delivered yet, so there is nothing to send. Same gap that keeps
the `order_delivered` admin notification from ever firing.

**No resend.** If the email fails after its retries, there is no way to send it
again short of SQL — and for a guest the token is gone by then, so a resend
would go out without one.
