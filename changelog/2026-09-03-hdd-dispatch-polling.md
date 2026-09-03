# Dispatch polling: orders now carry real tracking

## What changed

Kinkané now collects Gardners' `.HDD` dispatch files and puts the results on the
customer's order. `carrier`, `trackingNumber`, `trackingUrl` and `dispatchedAt`
stop being permanently null, and a shipped order moves from `acknowledged` to
`dispatched`.

Before this, those five columns existed, were returned by every order endpoint,
and were **never written by anything**. The API contract has advertised tracking
since migration `0039`; this is the producer behind it.

## Why now

The fulfilment cycle stopped at acknowledgement — "Gardners has accepted your
order" — and never advanced. Customers had no way to learn a parcel had shipped,
and `GET /orders/:id` returned an empty tracking block however long ago it
actually left the warehouse. The order UI's Delivered tab was unreachable.

## How it works

Every 30 minutes, on the same tick as the existing acknowledgement poll:

1. List `HOMEDISP` and take every `*.HDD` whose `.DONE` sentinel is present.
2. Download, parse, delete both remote files.
3. Fan each DETAIL record out to the order line it names.
4. Roll the result up onto the customer order.

## The structural difference from the ack poll

An `.ACK` is per-order: we know its filename because we chose it, so polling is
"fetch `{fileStem}.ACK` and see if it is there."

A `.HDD` is **per-account**. Gardners numbers the files itself — "usually from
00000001.HDD upwards, although this may change without prior warning" — and one
file carries dispatches for many different customer orders, while one order's
lines can arrive spread across several files. So this lists a directory rather
than fetching a known name, and every record has to be attributed individually.

The link is the **UNIQUE REFERENCE** we send in the `.ORD`, which is the order
line's own row id. Note that the ISBN in a dispatch record is deliberately *not*
used for matching: the spec allows an out-of-print title to be slipped to a
different edition, so the ISBN legitimately differs from the one ordered. It is
recorded, so a substitution is visible rather than inferred.

## Data shape

New table, `gardners_dropship_dispatches` — one row per DETAIL record, i.e. per
item actually shipped:

| Column | Notes |
| --- | --- |
| `order_line_id` | FK to `gardners_dropship_order_lines`; the UNIQUE REFERENCE |
| `dispatch_no` | Gardners' number; items in one parcel share it |
| `isbn13` | What was actually supplied — may differ from what was ordered |
| `quantity` | Quantity on *this* dispatch |
| `dispatched_on` | Dispatch date |
| `price_pence`, `delivery_pence`, `discount_basis_points` | What Gardners charged **us**, for invoice reconciliation |
| `carrier`, `tracking_number`, `tracking_url` | Recovered from free text — see below |
| `raw_detail` | DETAIL1-4 verbatim |
| `source_file` | The `.HDD` it came from |

A separate table rather than columns on the order line, because dispatch is
many-to-one with a line: the spec is explicit that when a wait time is exceeded,
"the one title may be shipped on multiple dispatches." Folding the newest
dispatch onto the line would silently discard the earlier shipment and its
tracking number.

## The awkward part: carrier and tracking are prose

There is no carrier field in the `.HDD`. No tracking-number field either, and no
URL field. All three live inside DETAIL1-4, which the specification describes
only as "an English description of the dispatch method", possibly including "the
shipper parcel/reference number and/or Recorded Delivery number along with a
Contact Name/Telephone number".

From the spec's own example:

```
"Dispatched Royal Mail 48 Tracked","Contact Royal Mail On:",
"www.royalmail.com/track-your-item","     Tracking Number: NU815785655GB"
```

So the extraction is built to **degrade rather than guess**:

- **Carrier** prefers `Contact X On:` over `Dispatched X`, because the latter
  mixes in the service level ("48 Tracked"), which is not the carrier. Falls
  back to DETAIL1 minus its prefix — a slightly-too-long carrier name still
  helps a customer, where null does not.
- **Tracking number** is anchored on an explicit label, never on the shape of
  the value. A shape matcher tuned to Royal Mail's `AA123456789GB` silently
  fails on every other carrier, and a looser one cheerfully returns the phone
  number out of the adjacent `Contact ... On:` line. There is a test for exactly
  that false positive.
- **Tracking URL** is normalised to absolute `https://` — Gardners writes it
  bare, and a bare host in an `href` resolves against our own domain and 404s.
  Only http/https survive: supplier prose ends up in a link, so a `javascript:`
  payload must not.

Every field is independently optional, and `raw_detail` always keeps what
Gardners actually said. A null tracking number renders as "dispatched, no
tracking yet", which is true. A *wrong* one sends the customer to a stranger's
parcel.

## Decisions worth knowing

**Which tracking number wins when a parcel splits.** An order can ship as
several parcels with different numbers, and `orders` has room for one. The first
dispatch carrying a tracking number wins, and later ones do not overwrite it —
a "track my parcel" link that changes each time another box ships is worse than
one that points at the first. Every parcel is recorded in full on the new table,
so nothing is lost and a future multi-parcel UI reads from there.

**Forward-only.** An order already `delivered`, `refunded` or `cancelled` is left
alone, so a late-arriving dispatch file cannot walk a finished order backwards.
`paid` is an accepted starting point as well as `acknowledged`, because a
dispatch can plausibly land before the ack poll has caught up.

**Idempotency is enforced by the database.** `uq_gardners_dropship_dispatch_line`
on `(dispatch_no, order_line_id)` makes re-reading a file a no-op rather than a
duplicate shipment. That matters because the cron runs in every worker process
at once — only a unique index can actually arbitrate two simultaneous polls.

**25 files per run.** HDD files are account-wide, so a backlog builds if polling
has been down. A cap keeps one run bounded; the rest arrive on the next pass.

**A record naming an unknown line is counted and logged, not thrown.** Gardners
keeps files for 30 days, so a stale file is plausible — and one stray record
must not cost the rest of the file.

## Explicitly out of scope

- **Delivery confirmation.** `.HDD` reports dispatch only; there is no delivery
  feed in the I12 specification. The `delivered` status and `deliveredAt` remain
  unreachable — reaching them needs carrier-level tracking, which is a different
  integration.
- Backorder (`BACKORD.TXT`) reconciliation, cancellation (`.CRF`/`.CRA`) and ASN
  invoice ingestion. Still later pieces of the same cycle.
- No new API endpoints. The order endpoints already returned these fields; they
  now have values.

## How it was verified

- The parser is tested against **the specification's own example file, verbatim**
  — if it cannot read that, it cannot read anything Gardners sends.
- Extraction is tested for: both carrier phrasings, all four tracking-number
  labels the spec mentions, the phone-number false positive, bare-host URL
  normalisation, and `javascript:` rejection.
- Robustness: multiple orders per file, items sharing a dispatch number,
  untracked dispatches, a record with no unique reference, LF-only endings, a
  missing trailer, unknown record types, an empty file.
- The poll is tested with SFTP doubled: `.DONE` gating, remote cleanup of both
  files, unmatched records, the already-recorded no-op, line-status advancement,
  and multiple files in one run.
- The rollup was run against a real database: a dispatch parsed from the spec
  example put `Royal Mail` / `NU815785655GB` /
  `https://www.royalmail.com/track-your-item` / `2020-01-17` onto a real order
  and moved it to `dispatched`; a second parcel did not overwrite the first
  link; a `delivered` order was not walked back; and re-inserting the same
  dispatch was a no-op.
- 33 new tests. `tsc --noEmit` clean. Full suite passes apart from four
  pre-existing environment-dependent failures in `subscription-pricing` and
  `referral-copy` that also fail on `main`.

**Still gated in development.** `isDropshipSftpBlocked()` covers this poll like
every other Gardners call, so nothing reaches the supplier locally unless
`GARDNERS_DROPSHIP_ALLOW_IN_DEV=true`.
