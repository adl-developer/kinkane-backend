# The admin console back end

## What changed

The staffed back office the web designs draw across ten screens now has an API.
Fifteen endpoints under `/admin/console`, plus one public endpoint the
storefront reads.

**Identity.** A new `admins` table, its own login (`POST /admin/console/auth/login`),
its own signing secret (`ADMIN_JWT_SECRET`), 12-hour sessions and no refresh
token. Accounts are made with `npm run admin:create`.

**Dashboard** — `GET /admin/console/dashboard` (the four overview cards and
recent orders) and `GET /admin/console/badges` (the sidebar counts).

**Orders** — `GET /admin/console/orders`, read-only, with the three designed
tabs plus a `needs_attention` bucket, search, and optional line items.
`GET /admin/console/orders/export` streams CSV.

**Customers** — `GET /admin/console/customers` with lifetime totals and the
three stat cards; CSV export; `POST`/`DELETE .../{id}/blacklist`.

**Reports** — `GET /admin/console/reports` (the moderation queue),
`POST .../{id}/dismiss`, and `POST .../{id}/blacklist` (blocks the reported
account and closes every pending report against them). The `user_reports` table
gained a status, a display reference (`R003`), and who-resolved-it.

**Settings** — `GET`/`PUT /admin/console/settings/banners` for the two
announcement strips, and the public `GET /api/v1/settings/banners` the
storefront reads.

**Notifications** — `GET /admin/console/notifications`, `POST .../read-all`,
`DELETE` (clear). Three of the four event types fire today.

## Why

There was no admin console at all — just one static `ADMIN_TOKEN` shared by
Bull Board and the Gardners dropship routes. Ten designed screens had nothing
behind them.

## The decisions that shaped it

**Admins are a separate table, not a role flag on `users`.** This console can
blacklist a customer and export the entire customer list. Keeping the two
populations apart means no path through the customer-facing auth stack — social
login, password reset, email change — can ever end with a customer holding admin
rights. The blast radius of a bug in the app's auth is customers only. The cost
is a second login stack, which is why it is deliberately minimal.

**A separate JWT secret, and the console refuses to run without it.** The
tempting fallback — reuse `JWT_ACCESS_SECRET` — would mean any customer access
token verifies against the console. When `ADMIN_JWT_SECRET` is unset the console
returns 503 to every login rather than falling back. An unconfigured console
nobody can log into is a deployment problem; one every customer can log into is a
breach. Belt and braces: the token also carries `kind: 'admin'`, checked on
verify, so even a misconfiguration where the two secrets matched would not let an
app token through.

**Sessions re-read the admin on every request.** Disabling an admin then takes
effect on their next call, not whenever their token happens to expire. One
indexed lookup per admin request, which at console traffic is nothing.

**Orders is read-only.** The screens have no action controls, so there is no
endpoint to change a status, refund, or resend. Adding one later should be a
deliberate decision, not an accident of scaffolding.

**Two tabs beyond the designs, split on whether money moved.** Processing /
Shipped / Delivered cover only five of the eleven statuses. The rest divide on
the line that decides what an operator has to do about them:

- `needs_attention` — `supplier_rejected`, `refunded`, `cancelled`. Money moved
  and something is wrong. `supplier_rejected` is the urgent one: the customer
  paid and the supplier will not fulfil, so we owe them a book or a refund.
  `fulfilmentError` carries the reason.
- `unpaid` — `pending_payment`, `payment_failed`, `expired`. Nobody was ever
  charged. No sale, nothing owed.

These began as one bucket with `payment_failed` filed next to
`supplier_rejected`, which made the badge meaningless: "3 need attention" could
have been three declined cards (nothing owed) or three paid orders stuck at the
supplier (three people waiting for a book they paid for). Same number, opposite
urgency.

`unpaid` is also a real, selectable tab rather than a count with no way to open
it — the first version reported `pending: 1` in `counts` and returned 400 for
`?tab=pending`, which is a dead-end badge.

Three tests hold the taxonomy: every schema status maps to a tab, no status maps
to two, and no tab mixes charged with uncharged orders. The last one caught its
own author — `cancelled` is charged, which the customer-facing list had already
settled by including it among the orders "a customer would recognise".

**Blacklisting is reversible and non-destructive.** It blocks signing in and
checking out; it does not touch posts, reviews, shelf or order history.
Moderation decisions get revisited, and a blacklist that deletes content cannot
be undone. Checkout is guarded separately from login, because a session issued
before the blacklist stays valid until its token expires — "blocked" that still
lets someone spend money is not blocked.

**"Blacklist from report" closes every pending report against that user.** Three
people reporting the same person is one decision; leaving the others open means
the next admin re-reviews an account that is already blocked.

**The dashboard counts paid orders only — cards and Recent Orders table alike.**
First built with the cards filtered and the table unfiltered, which showed
"TOTAL ORDERS 0" sitting directly above a table listing two of them: a dashboard
arguing with itself. It also contradicted the rule the customer-facing order list
already states — "an abandoned checkout is not an order, and listing one reads as
a billing error". Abandoned checkouts stay reachable on the Orders screen,
counted as `pending` and included in its `all` tab, which is where someone
diagnosing a broken checkout would look.

**"Active" means paid in the last 12 months.** A customer who has never ordered
is inactive, not new — the operator wants to know who is buying.

**Notification read-state is shared across admins.** With a small team on one
queue, "somebody has seen this" is the useful meaning, and a per-admin join
table is more machinery than the bell is worth.

**Notifications never throw.** Every emitter sits inside a flow that matters more
than the bell — a paid order, a signup, a filed report. A failed notification
insert logs and swallows rather than failing the thing it describes.

**Tab status lists are defined once.** The dashboard counted `processing` and
`needs_attention` with hardcoded SQL string literals while the Orders screen used
the `ADMIN_ORDER_TABS` table — the same lists in two places. They agreed on the
day they were written, which is the only day duplicated lists ever agree. The
dashboard now derives its counts from the same table, so a card and its tab
cannot disagree about the same orders.

**CSV exports are formula-injection safe.** A field starting `=`, `+`, `-` or `@`
is prefixed with an apostrophe, so a customer named `=HYPERLINK(...)` cannot
execute on an operator's machine. A UTF-8 BOM makes Excel on Windows render
non-ASCII names. Exports respect the current filter and cap at 5,000 rows — an
unbounded export of a growing table is a way to take the server down from a
button.

**Announcement banners: a row per slot, saved together.** There are exactly two
and the slot is the primary key, so a third cannot appear by accident. `PUT`
saves both in one transaction — the design has one Save button, and a partial
write would show one banner from before the edit and one from after. The admin
endpoint returns both slots with their toggles; the public one returns only the
enabled ones, because a storefront has no business knowing the copy of a banner
it is not showing.

## What is emitted, and what is not

Three of the four notification types fire: `report_filed` (when a customer files
a report), `order_received` (when a payment lands), `customer_registered` (on
signup, both password and social). **`order_delivered` never fires yet** —
nothing marks an order delivered, because there is no delivery signal from the
courier. The type exists so the feed needs no change when one arrives.

## Explicitly out of scope

- **No order actions** — status changes, refunds, resends, fulfilment retry.
  Read-only by design.
- **No 2FA, SSO, or password reset for admins.** The designs show email +
  password only. `admin:create` doubles as the reset path.
- **No per-admin read state**, no admin audit log beyond `resolvedBy` /
  `blacklistedBy` / `updatedBy` stamps.
- **Dashboard aggregates are live**, not a rollup. Fine at current volumes;
  "all time" only gets slower, so this wants a nightly rollup before `orders`
  passes a few hundred thousand.

## Found in review, after the first version

Three defects an audit turned up, all now fixed and covered by tests:

**The blacklist only blocked one of three ways in.** `assertNotBlacklisted` sat
on the password login and nowhere else, so a blacklisted customer stayed signed
in indefinitely: their client traded a refresh token for a fresh pair on a timer
and never needed to log in again. "Continue with Google" walked past it too.
Demonstrated live before fixing — blacklisted account, `403` at login, `200` and
a new token pair from `/auth/refresh` a second later. Refresh and both social
paths are now gated, and blacklisting revokes existing refresh tokens on the
spot (`sessionsRevoked` reports how many). The remaining window is their current
access token until it expires, which is why checkout keeps its own check.

**Admin login shared the customer login rate-limit bucket.** Both keyed by IP at
`rl:login:`, so a brute force against the customer app would have locked staff
out of the console at the moment they most needed it. Admin sign-in now has its
own bucket, tighter (10 per 15 min) because the population is a handful of people
who know their password.

**CSV exports truncated silently.** The 5,000-row cap protects the server, but an
operator who asks for 12,000 customers, receives 5,000 and is told nothing will
believe they hold the whole list. Exports now return `X-Total-Rows`,
`X-Exported-Rows` and `X-Truncated`, and a truncated file is *named*
`…-FIRST-5000-OF-12345.csv` — the filename being the only part someone clicking
a download button ever actually sees.

## Seeding admins

`npm run admin:create` handles one account or many, and hashes every password
with bcrypt before anything reaches a query — the same helper the login path
verifies against, so a seeded password and one set later are indistinguishable.

```bash
# one, prompted (a person at a terminal)
npm run admin:create -- --email ama@kinkane.app --name "Ama Boateng"

# one, non-interactively (CI, containers)
ADMIN_PASSWORD='…' npm run admin:create -- --email ama@kinkane.app --name "Ama"

# several, from a file
npm run admin:create -- --file admins.json
```

Re-running for an existing email updates it, which is also the password-reset
path — there is no self-service one.

Two guards worth knowing about. It **refuses a seed file that sits inside the
repository unless git ignores it**, because such a file holds plaintext
passwords and committing one is invisible until it is in the history forever.
And it enforces a 12-character minimum: these accounts can blacklist customers
and export the customer list.

## Verification

Migrated and exercised live against the local database (83,688 books, real
orders and users) with the server running. Walked the full console: login
(right and wrong password, and a non-admin token — all correctly rejected),
dashboard, badges, orders with items and tab counts, customers with stats,
banner edit + public filtering + the empty-text rejection, then the moderation
path end to end — filed a report through the real customer endpoint, saw
`report_filed` and `order_received` and `customer_registered` land in the feed
with correct badges, blacklisted from the report (which resolved it and flagged
the user), confirmed the blacklisted account gets **403 at login**, then
unblacklisted and cleared. Both CSV exports checked for the BOM, content type,
attachment disposition and header row. Seed data removed afterwards.

New unit tests: `csv.test.ts` (escaping and formula-injection) and
`admin-order-tabs.test.ts` (the status→tab mapping, including the guard that
every schema status is covered). Full suite 334 passing; the 3 failures in
`subscription-pricing.test.ts` pre-date this work.

The OpenAPI document builds clean — 109 paths, all 15 console endpoints and the
five new schemas, every `$ref` resolving.

**Not done:** the migration has run only on the local database. `ADMIN_JWT_SECRET`
and `SUPPORT_INBOX` must be set in each real environment before the console and
contact form work there.
