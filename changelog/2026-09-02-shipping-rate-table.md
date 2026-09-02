# Gardners shipping costs, as data

**Date:** 2026-09-02

## What changed

A new `shipping_rates` table holds what Gardners charge us to send a parcel, by
service, destination and weight. It is seeded with 4,051 prices taken from
their own sheets: the July 2026 international CDF spreadsheet and the October
2025 Royal Mail sheet.

Nothing reads it yet. This change is the data; the quote path moves onto it
next.

## Why a table

The flat `SHIPPING_RATES` environment variable could not express the thing that
actually drives the cost. A parcel to Ghana costs £30.61 at 250g and £104.98 at
10kg. One number for "rest of world" is wrong at both ends, and there is no
string short enough to hold four thousand figures.

Rates are also reissued a couple of times a year, so re-pricing should be a
re-seed rather than a deploy.

## Data model

| column             | notes                                                      |
|--------------------|------------------------------------------------------------|
| `service_code`     | Gardners' I12 code — `001`/`002` UK, `010`/`011` airmail, `015` BFPO |
| `country_code`     | ISO alpha-2                                                 |
| `parcel_kind`      | `large_letter` or `parcel`                                  |
| `max_weight_g`     | upper bound of the band, inclusive                          |
| `price_pence`      | what Gardners charge us, unmarked-up                        |
| `peak_price_pence` | Royal Mail's 17 Nov – 6 Jan price; null except UK large letter |
| `effective_from`   | when the sheet came into force                              |
| `source`           | which sheet, for tracing a figure back                       |

Unique on (service, country, shape, band, effective date), which is what makes
the seed idempotent — re-running corrects prices in place.

Rows are never updated for a new sheet. A new sheet is seeded under a new
effective date alongside the old rows, so an order placed last month can still
be re-priced at the rates that were live when it was placed.

## Non-obvious decisions

**`parcel_kind` exists because one UK service code has two prices.** Royal Mail
charges £1.91 for a large letter and £2.22 for a parcel of the same weight, and
Gardners send whichever the item fits — their service-code table says packages
are "tracked by default excluding Large Letter". So which price applies is
decided by the book's dimensions, not by anything we choose. Every
international rate is a parcel; the distinction is a UK-only artefact.

**Prices are costs, not prices.** Nothing here is marked up. The fulfilment
fee, the EU customs surcharge and any margin are added at quote time. Keeping
the vendor's numbers unmodified is what makes an invoice reconcilable against
an order.

**"Tracked DDP" is not seeded.** It is genuinely cheaper into the EU and spares
the buyer a customs bill, but Gardners' service-code table has no code for it —
we would be able to price a DDP order and then have no way to submit one.
Waiting on an answer from them.

**Portugal and Spain carry their mainland price.** Gardners price the
Portuguese islands and the Canary Islands separately and higher. ISO alpha-2
cannot express that, so those rows are dropped. It errs in the customer's
favour, not ours.

## Regenerating

`scripts/generate-shipping-rates.py` turns the vendor spreadsheet into
`src/db/seeds/shipping-rates.ts`. It needs `openpyxl` and is deliberately not
wired into `package.json`, because the spreadsheets arrive by email and are not
in the repo:

```
python3 scripts/generate-shipping-rates.py \
  --international ~/Downloads/international-cdf-july-2026.xlsx \
  --out src/db/seeds/shipping-rates.ts
```

It refuses to write a partial table. Any country name it cannot map to an ISO
code is a hard failure, because a silently skipped row is a destination that
later gets quoted a fallback, or refused, with nothing in the logs saying why.
The UK figures are typed into the script rather than parsed — they come from a
PDF whose two-column layout does not survive text extraction, and there are
only fourteen of them.

## What this surfaced

Five countries we accept orders for have **no published rate on either sheet**:
Ethiopia, Liberia, Rwanda, Sierra Leone, Senegal. Three more — Cameroon, Gambia,
Tanzania — appear only on the untracked sheet, while we send every overseas
order tracked. That is nine destinations we can currently sell to and cannot
correctly price.

Both lists are asserted in `shipping-rate-seed.test.ts`, so the situation is
pinned rather than merely known: a country quietly dropping out of the next
sheet fails the build.

## Verified

Migration applied and the seed run twice against the development database:
4,051 rows in 157ms, unchanged on the second run. Spot-checked Ghana tracked
(£30.61 / £32.52 / £34.42 / £36.33 across the first four bands) and untracked
(£8.45 / £15.86 / £23.27 / £30.69) against the spreadsheet.

Eight seed-integrity tests cover band alignment, ascending bands, prices never
falling as weight rises, peak prices only on UK large letters, and the two
coverage gaps above.
