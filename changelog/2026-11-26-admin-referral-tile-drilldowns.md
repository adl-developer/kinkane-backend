# Admin referral tiles: drill-down lists

## What changed
Each tile on the admin Referrals screen can now open its own list:

- `GET /admin/console/referrals/list`: one row per referral (sender, sender country, receiver,
  receiver country, sign-up date, verified). Paged, and searchable on either side.
- `GET /admin/console/referrals/countries`: the countries and continents reached, by full name,
  with signup counts.
- `GET /admin/console/customers?referred=successful` (and `/customers/export`): the Customers
  list narrowed to people who joined through a referral link and verified their email.

## Why
The client asked for the tiles to show where their numbers come from. Each list uses the same
filter as its tile, so its length equals the number shown.

## Decisions
- The referral list has one row per *signup*, not per share. A WhatsApp or SMS share has no
  receiver we can see. The Sent tile is floored to signups (fix/referral-sent-floor), so the tile
  and the list agree.
- Receiver country is the one snapshotted at redemption, which is what scored. Sender country is
  their current one.
- Country names come from the seeded `countries` table. `Intl.DisplayNames` covers only codes the
  table lacks (for example XK).
- "Successful signups" reuses the Customers endpoint so the console can reuse the Customers table.

## Out of scope
Console UI (client team: see docs/client-integration-2026-11-26-admin-referral-drilldowns.md).
Senders' countries don't count toward Countries Reached. That rule is unchanged.

## Verified
admin-referrals integration suite against a scratch Postgres: list rows and countries, search,
voided referrals excluded, reach list lengths equal the tiles, Customers filter total equals
`totals.successful`. Unit suite green.
