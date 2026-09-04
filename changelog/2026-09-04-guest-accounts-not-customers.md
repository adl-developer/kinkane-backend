# The console stops counting browsers as customers

**Date:** 2026-09-04

## What changed

The admin console no longer treats the accounts the web shop creates on a
visitor's behalf as customers — unless they bought something.

- The Customers list and its three cards now cover real customers only.
- The Overview's total and active customer cards use the same definition.
- Guests who **completed a purchase** are kept, flagged with a new `isGuest`
  field on the API response.
- The Orders screens now show the buyer's name against a guest order instead of
  the word "Guest".

## Why

The web shop needs a Bearer token on every cart and checkout call, so rather
than show a login wall it silently signs the browser up on first add-to-cart —
name "Guest", address `guest-<uuid>@guest.kinkane.app`, generated password (see
`createGuestAccount` in the web frontend). Those go through the ordinary signup
endpoint, so down here they are indistinguishable from real accounts: real
password hash, real session, even a Plus trial.

There are roughly ten of them for every real signup — one per browser that ever
opened the shop, and another whenever someone clears their storage. The console
counted every one as a customer, and after the switch to sign-in-based activity
it counted every one that made a request as an *active* customer. "Active
customers" had become a count of abandoned carts.

## Where the line is drawn

Not at "is a guest" but at **has ordered, or is not a guest** —
`countsAsCustomer` in `services/admin/dashboard.service.ts`, exported so the
list and the cards cannot drift apart on it.

A guest who completed a checkout is real money and a real person the operator
may need to contact, so they stay, flagged. A guest that never ordered is a
browser: no name, no reachable address, nothing to act on.

A pleasant side effect is that `stats.totalSpentMinor` now agrees with the
customer base. It sums all paid orders, and the only guests excluded are the
ones with no orders to contribute.

## `is_guest`, rather than matching the email

Migration `0058_user_is_guest` adds a boolean, set at signup and backfilled from
the email domain once.

The domain is a convention the *frontend* owns. A console query that
pattern-matched it would be a business metric that breaks silently the day
someone renames that host — so the string is read in exactly one place
(`isGuestEmail`, at signup) and never consulted again. The backfill uses `ILIKE`
because it runs once, can never be re-run to catch a row it missed, and a miss
is invisible.

No index on the column. The predicate is "not a guest, OR has a paid order", and
the half that costs anything is the order lookup, already served by
`idx_orders_user_id`. A two-value index would not be used for the `OR`, and an
index nothing reads is a write to maintain on every signup.

## The "Guest" name bug

Both order screens built the customer name as
`coalesce(users.name, orders.shipping_name)`. That was correct when written — a
guest order then had `user_id IS NULL` and it fell through to the shipping name.

Now guest orders point at a real row whose name is the literal string "Guest",
so the coalesce never falls through, and every guest order in the Orders list
and Recent Orders read "Guest" in the customer column. Since guest checkout is
most orders, that column had stopped distinguishing anyone. Replaced with a
shared `orderCustomerName` that prefers the shipping name for guests and the
account name for everyone else.

## Not fixed here

**Every guest account opens a Plus trial.** Signup writes a `user_subscriptions`
row (`tier: 'plus', status: 'trialing'`) and a `subscription_events` row for
each one, so trial and subscription figures are inflated by abandoned carts in
the same way the customer count was. That is a decision about what a trial
means, not a reporting scope, so it is left alone — but it is the same root
cause and worth its own change.

Also unchanged: the shop still creates an account per browser. Narrowing what
the console *reports* does not reduce what the table *stores*, and those rows
keep accruing.

## Testing done

`src/__tests__/customer-activity.test.ts` covers the scoping: every customer
query in `list()` carries `countsAsCustomer`, the predicate keeps guests who
ordered rather than dropping all guests, the email convention appears at signup
and nowhere in the admin services, and both order screens use the shared name
expression rather than the old coalesce.

Full suite: 688 passing. The four failures in `subscription-pricing` and
`referral-copy` predate this work and fail identically on a clean tree.

**Not run against a database.** Migrations `0057` and `0058` are both still
unapplied.
