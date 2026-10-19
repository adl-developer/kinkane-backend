# Let customers ask for out-of-stock books to be restocked

**Date:** 2026-10-19

## What changed

Customers can now press **Request Restock** on a book that is out of stock, on the
website or in the app. Each request is stored and shows up in a new **Restock
Requests** screen in the admin console, with a sidebar badge and an entry in the
admin bell. The admin arranges the restock with Gardners by phone or email and
contacts the customer themselves. Nothing about that is automatic.

This is the API only. The book-page button, the confirmation and the admin
screen are built by the web, app and console teams against the designs in the
Kinkané Web eCommerce Figma (Admin › "Request restock", Web › "Out of stock").

### Customer endpoint

`POST /api/v1/books/:id/restock-requests`. Public, with an optional token.

```json
{ "name": "Amara Diallo", "email": "amara.diallo@email.com" }
```

Both fields are optional, as in the design, so a guest may leave neither. A
customer signed in to a real account can send `{}` and is filed under the
account's name and email. The web shop's silent guest accounts (named "Guest",
with a made-up address) are not copied: they need the form like anyone signed
out. Returns `201 { "requested": true }`.

Which editions qualify:

| Edition | Answer |
|---|---|
| Out of stock, reprinting, or out of stock indefinitely | `201` |
| In stock, or supplied to order (extended catalogue, print on demand) | `409 IN_STOCK` |
| Not licensed for sale in the customer's country (when known) | `409 MARKET_RESTRICTED` |
| No price | `409 NOT_FOR_SALE` |
| Withdrawn or missing | `404 BOOK_NOT_FOUND` |

### Admin endpoints (`/admin/console`)

- `GET /restock-requests?status=all|pending|fulfilled&q=&limit=&offset=`: one
  card per edition with its requests, plus Total / Pending / Fulfilled counts.
- `GET /restock-requests/export`: CSV of the current tab and search.
- `POST /restock-requests/:id/fulfil` and `POST /restock-requests/:id/reopen`:
  mark one person's request fulfilled, and undo it.
- `POST /restock-requests/books/:bookId/fulfil`: "fulfil all" on a card.
- `GET /badges` now includes `restockRequests` (pending).
- The bell gets a new `restock_requested` event.

## Data model

New `restock_requests` table (migration `0087_restock_requests`):

| column | notes |
|---|---|
| `id`, `reference` | `reference` is `RR001`, stamped from the id after insert |
| `book_id`, `isbn13` | the edition asked for; the ISBN is a snapshot |
| `user_id` | set when signed in; `set null` if the account is deleted |
| `name`, `email` | optional; copied from a real account when the form is empty |
| `status` | `pending` or `fulfilled` |
| `fulfilled_at`, `fulfilled_by` | who marked it fulfilled, and when |
| `admin_emailed_at` | for the admin email, a later phase; always null today |
| `created_at` | |

The migration also adds `restock_requested` to the `admin_notification_type` enum.

## Decisions, and why

All settled with the client on 2026-10-19:

- **Only out-of-stock editions.** Supplied-to-order books stay buyable and get no
  button, because the customer can simply order one. Restricted books get no
  button, because restocking would not let that customer buy it. An unknown
  country is never a reason to refuse.
- **No de-duplication and no quantity.** Every press is a row. Repeat requests
  read as demand, which is what the admin wants to see. The only brake is a rate
  limit of 20 an hour per IP, aimed at scripts, not shoppers.
- **One card per ISBN.** A paperback and a hardback are separate cards, because
  restocking at Gardners is per ISBN.
- **Newest request first**, and paged by card so a card never splits across two
  pages. Counters count requests, not books, and follow the search but not the tab.
- **Fulfilled means "dealt with".** No Dismissed status. The client added undo and
  "fulfil all" on top of the design's per-person Mark fulfilled.
- **Guest details are kept indefinitely.** No automatic erasure; the privacy
  notice's general "legitimate need" wording covers it.
- **No customer email.** The confirmation must not promise a notification. The
  agreed copy is "Request sent. We've told the Kinkané team you're after the
  Paperback."

## Left out

- **The admin email** to us@kinkane.app (one per request) is a later phase. The
  `admin_emailed_at` column is already there for it.
- **The "your cart has changed" behaviour.** When a book in a cart runs out, the
  client wants it taken out of the cart with a modal, plus an in-app bell
  notification for signed-in customers. Today the cart keeps the line and flags it
  `unavailable`. That is a cart change in its own right, not part of this API.

## How it was verified

- `restock-requests.integration.test.ts`: 20 tests against a scratch Postgres,
  covering every eligibility rule, guest and real accounts, no de-duplication, the
  bell entry, cards, counts, search (with literal `%`/`_`), paging, fulfil, undo,
  fulfil all, export and the badge.
- `restock-requests-endpoint.test.ts`: the HTTP layer (optional form, cleared
  fields, honeypot, bad ids and emails) and the reference and format helpers.
- Full unit suite, type-check, and the migration applied to the scratch database.
