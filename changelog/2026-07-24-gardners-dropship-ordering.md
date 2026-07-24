# Add Gardners dropship order submission and ack polling

**Date:** 2026-07-24

## What changed

This adds the first piece of a real purchase flow against Gardners Books:
submitting a customer fulfillment order and reading back whether Gardners
accepted, backordered, or rejected it. Gardners calls this their "I12 Home
Delivery" (dropship) service — we place an order for specific ISBNs against
an invoice/delivery address, and Gardners ships directly to the end
customer. This is separate from the existing Gardners integration
(`gardners-stock.ts` etc.), which is read-only catalogue/price/stock feeds —
this is bidirectional: we write a file, Gardners writes one back.

The flow, end to end:

1. `gardnersDropshipOrderService.createOrder` persists an order + one row
   per line (book) in Postgres.
2. `submitOrder` builds the exact CSV-with-CRLF `.ORD` file format Gardners'
   parser expects and uploads it to their `HOMEORD` FTP directory.
3. `pollAck` checks Gardners' `HOMEACK` directory for the matching `.ACK`
   (gated on the `.DONE` sentinel Gardners writes once it's safe to read),
   parses it, and reconciles each line to `fulfilled` / `partial` /
   `backordered` / `rejected` based on the `GARDNERSREF` and quantity-supplied
   fields Gardners returns.

A new admin surface (`POST /admin/gardners/dropship/orders`,
`GET .../orders/:id`, `POST .../orders/:id/poll-ack`) exposes this, gated by
the same static bearer token as `/admin/queues` — this isn't wired into
customer checkout yet, so it isn't versioned under `/api/v1`.

Also added `scripts/gardners-dropship-test.ts` — a CLI harness that resolves
ISBNs against the local catalogue for title/price, submits an order, and
polls until Gardners acknowledges it. `npm run gardners:dropship-test`.

## Data model

Two new tables ([gardners-dropship-orders.ts](../src/db/schema/gardners-dropship-orders.ts)):

- `gardners_dropship_orders` — one row per `.ORD` file. `file_stem` is a hex
  timestamp that doubles as both the filename and the HEADER `SEQUENCE`
  field (unique, monotonically increasing, satisfies Gardners' "numeric
  order number, hex allowed" requirement without a shared counter).
  `testing` mirrors the HEADER `TESTING` flag — Gardners acknowledges test
  orders normally but never creates the underlying order lines.
- `gardners_dropship_order_lines` — one row per book on the order. A line's
  own serial `id`, zero-padded to 9 digits, **is** the EDI "unique
  reference" field the spec requires — no separate sequence needed. Carries
  a full snapshot of the home-delivery fields as submitted (addresses,
  price, service code, tracking info) so the `.ORD` file could be rebuilt
  for audit without depending on mutable book/price data later.

Migration: [0024_romantic_karnak.sql](../drizzle/0024_romantic_karnak.sql).

## Non-obvious decisions

- **The invoice address block has an inconsistent prefix in Gardners' own
  spec, and it's not a typo.** `TITLENAME`/`INITIALS` are unprefixed for the
  invoice address but every other invoice field (`INAME`, `IADDR1-4`,
  `IPCODE`, `ICOUNTRY`) carries the `I` prefix — while the delivery block
  prefixes everything, including `DTITLENAME`/`DINITIALS`. Caught this by
  diffing `order-builder.ts`'s output against a real, Gardners-accepted
  order file in `EDI_docs/000000043.ORD` — first pass was byte-different on
  exactly those two lines.
- **Rejected vs. backordered isn't just "quantity supplied is zero."** Per
  the spec, Gardners only omits `GARDNERSREF` (or sends `0`) when a line is
  truly rejected (e.g. a market-restricted title); a real `GARDNERSREF` with
  `quantitySupplied = 0` means "accepted, but backordered." Verified this
  distinction against `EDI_docs/000000044.ACK`, where the second line got a
  real ref (`414879638`) with 0 supplied.
- **`.ORD` files are written with CRLF line endings per the spec text**,
  even though the real sample files in `EDI_docs/` are saved with bare LF —
  that's presumed to be an artifact of how they were saved to this repo
  after the fact, not evidence Gardners' parser wants LF.
- SFTP credentials for the Home Delivery account
  (`GARDNERS_DROPSHIP_SFTP_*`) are separate env vars from onix_ingester's
  Bespoke Inventory / Generic Data feed accounts, and are optional in the
  env schema — unset, the app boots and every other route behaves exactly
  as before; the dropship module only touches Gardners when one of its
  endpoints/scripts is actually called.

## What's explicitly out of scope (for now)

- Dispatch (`.HDD`) polling, backorder (`BACKORD.TXT`) reconciliation,
  cancellations (`.CRF`/`.CRA`), and ASN/invoice ingestion — later stages of
  the same I12 cycle, not needed to prove order → ack works end to end.
- Not wired into customer checkout — addresses/prices are supplied directly
  to the service today; there's no cart/order model on the customer-facing
  side yet.
- No dedicated automated tests were added in this pass.

## Testing done

- `order-builder.ts`'s output diffed byte-for-byte against a real,
  Gardners-accepted order (`EDI_docs/000000043.ORD`) — exact match after
  fixing the invoice title/initials prefix bug above.
- `ack-parser.ts` run against both real sample ACKs in `EDI_docs/`
  (`000000043.ACK`, `000000044.ACK`) — correctly recovers the real
  `GARDNERSREF`s Gardners issued and correctly classifies the
  backordered-but-accepted line.
- `createOrder`/`getOrder` smoke-tested live against the dev Postgres
  instance (row created with correct types and the expected zero-padded
  unique reference, then deleted).
- Confirmed the app boots and all existing routes/tests are unaffected with
  `GARDNERS_DROPSHIP_*` env vars completely unset: config still parses,
  `/api/health` still returns `200`, the new admin route returns `401`
  (missing bearer token) rather than a `500`, and the existing 14-test suite
  still passes.
- Full live submission against Gardners' actual HOMEORD/HOMEACK directories
  has not been run yet — pending Home Delivery account credentials.
