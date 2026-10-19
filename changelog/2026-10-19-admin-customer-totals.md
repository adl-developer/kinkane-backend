# Admin Customers screen shows each customer's real orders and spend

## What changed

On the admin console's Customers screen (and its CSV export), the **Orders**, **Total spent** and **Last order** columns now show the customer's own paid orders. Before this fix, practically every customer read 0 orders, 0 spent and no last order, however much they had bought.

## Why

Each of those three figures is a small subquery over `orders`, written with `${users.id}` for "this customer". The Customers list selects from `users` with no join, and in that case Drizzle prints select-list columns without their table name. `${users.id}` came out as a bare `"id"`, and inside `from orders o` Postgres reads that as the **order's** id. So each subquery counted orders whose `user_id` equalled their own order id: almost always none, and never this customer's. Nothing errored, so the zeros looked like real data.

The bug turned up while building the referral Travellers list, which uses the same pattern.

## Decisions

- The customer's id is now written as `"users"."id"`, which can only mean the outer row. This is the same fix the referral Travellers list uses.
- **Checked the rest of the codebase for the same bug.** Every SQL fragment containing a subquery that interpolates a column was reviewed. The quirk only affects fragments used as **select-list fields in a query with no joins**. WHERE, ORDER BY, HAVING and raw `execute` SQL are always table-qualified. The Customers screen was the only place affected. The order item counts on the Dashboard and Orders screens, and the sale price in checkout availability, are safe because those queries join.
- The headline cards above the table (customers, active, total spent) were never affected. They don't use these subqueries.

## Left out

- No data needed correcting. The figures are computed when the screen is read and nothing was stored wrong.

## Verified

`admin-customer-totals.integration.test.ts` runs against a scratch Postgres. It sets up a customer with two paid orders and one unpaid order, and makes sure no order id can equal the customer's id. It expects 2 orders, 4000 spent and the later paid date. With the fix reverted, the same test fails with 0 orders and 0 spent. Typecheck is clean and the unit suite passes (1569 tests).
