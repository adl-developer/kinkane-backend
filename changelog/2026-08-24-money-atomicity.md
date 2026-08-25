# Race conditions on the money paths

## What changed

Three writes that move money were read-then-write, with a window in between
where a second request could do the same thing. All three are now atomic, and a
fourth guarantee is enforced by the database rather than by application code.

## Why it mattered

Every one of these fails silently. Nothing errors, nothing logs — the damage
only shows up when someone reconciles against Stripe or against a supplier
invoice, by which point the books have shipped.

### 1. `markPaid` — the conversion write

```
SELECT order → if status is 'pending_payment' → UPDATE to 'paid' → return true
```

Stripe delivers at-least-once, and two deliveries can arrive together. Both read
`pending_payment`, both returned `true`, and the caller runs fulfilment on a
`true` — so **the order was submitted to Gardners twice**: two copies shipped,
two supplier invoices, one payment.

Now a single conditional `UPDATE ... WHERE id = ? AND status = 'pending_payment'
RETURNING id`. Postgres serialises concurrent attempts on the row, so exactly
one updates it and the loser returns false. The read is kept as a fast path for
the obvious duplicate; the update is the check that actually holds.

### 2. `fulfilment.submit` — the write that ships books

Same shape: read the order, see no `gardners_dropship_order_id`, send to
Gardners, then record the id. Two workers — two instances, or a retried job
overlapping the original — both saw an unclaimed order and both sent it.

The order is now **claimed before the supplier is contacted**, with a
conditional update to `submitted_to_supplier` gated on `status = 'paid' AND
gardners_dropship_order_id IS NULL`. Whoever loses that update returns.

Claiming before rather than after is deliberate: a crash mid-send leaves the
order visibly in flight instead of looking like it still needs sending. The
catch block releases the claim back to `paid` when the send genuinely failed, so
a retry picks it up and an operator sees a paid order carrying an error — which
is exactly what the console's `needs_attention` tab is for.

### 3. The first-order discount

Eligibility was read outside the transaction that wrote the order. But this one
could not be fixed by moving the read inside, and it is worth being precise
about why: **two checkouts starting at the same instant both legitimately see
"no paid order"**. At that moment it is true for both. No isolation level makes
a true statement false.

Only a constraint evaluated at write time can stop both being written, so there
is now a partial unique index:

```sql
CREATE UNIQUE INDEX uq_orders_first_order_discount
ON orders (contact_email_normalized)
WHERE discount_reason = 'first_order'
  AND status NOT IN ('expired', 'payment_failed', 'cancelled');
```

Partial on purpose. It forbids *two live discounted orders for one mailbox*,
while orders that were never going to be paid drop out of the index — so
abandoning a discounted checkout and starting another still works. Losing that
would have traded one bug for a worse one.

When the index refuses a second order, the basket is **re-priced without the
promotion and written again**. The buyer gets an order rather than an error;
they were never owed two discounts, and failing their checkout to tell them so
is the wrong end of the trade.

The eligibility read also moved inside the transaction — belt to the index's
braces.

### 4. Two admin actions that were half-atomic

Blacklisting a customer updates the user row *and* revokes their refresh tokens.
Split, a crash between them leaves someone marked blacklisted whose sessions
still work — the exact state the blacklist exists to prevent, and one nothing
would re-check. Now one transaction.

"Blacklist from report" blocks the account and resolves every pending report
against them. Now one transaction too.

**A mistake worth recording:** the first version of that had
`blacklistAndResolve` open a transaction and call `blacklist()`, which opened
its own. Under postgres-js a nested `db.transaction()` takes a *separate
connection* — so the two writes would not have been atomic at all, and both
trying to update the same `users` row would have deadlocked. `blacklist()` now
takes an optional transaction handle, the same pattern
`subscriptions/state.service` already uses.

## Verified

Against the local database with the server running:

- **Six concurrent checkouts** for one fresh email → exactly **one** discounted
  order, five at full price, zero failures.
- **Abandon and retry** → the expired order leaves the index and the discount is
  available again.
- **Blacklist from report** → both the block and the resolutions commit
  together, no deadlock.

`src/__tests__/money-atomicity.test.ts` holds the shapes: the conditional update
on both claims, the claim ordered before the supplier call, the release on
failure, the unique index and its partial predicate, the re-price-and-retry, and
the transaction handle being passed down rather than nested.

## Not addressed

**`markPaid`'s fast-path read is still a read.** It is only an optimisation now,
but it means a duplicate delivery does one wasted SELECT before losing the
update. Harmless, and cheaper than the alternative.

**Nothing reconciles against Stripe retrospectively.** These changes stop
duplicates being created; they do not detect a historical one. The order
reconciliation cron is the place that would go.
