# Stop selling shipping below cost outside Europe

**Date:** 2026-09-02

## What changed

The flat shipping rates were set before we had Gardners' own cost sheets.
Measured against them, every non-European destination was being sold below
cost — in some cases far below.

A tracked 0.5kg parcel, which is what a single hardback weighs:

| Destination | We charged | Gardners charge us | Loss per order |
|-------------|-----------|--------------------|----------------|
| Ghana       | £11.99    | £32.52 + £0.70 fee | **−£21.23**    |
| Kenya       | £11.99    | £25.45 + £0.70 fee | −£14.16        |
| Nigeria     | £11.99    | £23.28 + £0.70 fee | −£11.99        |
| South Africa| £11.99    | £23.48 + £0.70 fee | −£12.19        |
| USA         | £8.99     | £10.80 + £0.70 fee | −£2.51         |
| Germany     | £6.99     | £6.15 + £0.70 fee  | −£0.86         |

Two changes:

**1. Rates re-derived from the cost sheets.** Each default is now the tracked
price at the 0.5kg band, plus Gardners' £0.70 fulfilment fee, plus the £3 EU
B2C customs surcharge inside the EU, rounded up. Destinations that the old
`ROW` average was hiding — Ghana, Nigeria, Kenya, South Africa, Jamaica — now
have entries of their own.

**2. Free shipping is no longer global.** A new
`SHIPPING_FREE_THRESHOLD_COUNTRIES` (default `GB`) gates where the
free-shipping threshold applies. A £40 basket to Ghana was being given a £33
parcel for nothing: the promotion cost more than the margin on the books it
was promoting. Setting the variable empty restores the old
everywhere behaviour, so the change is reversible without a deploy.

## Deployment note

`SHIPPING_RATES` is an environment variable, and production sets it explicitly.
**Changing the default here does not change what production charges.** The new
value has to be copied into the Render environment for this to take effect.

## What this is not

A stopgap, deliberately. It is still one flat rate per order and still assumes
a 0.5kg parcel, so a three-book basket to Lagos still loses money. It also
still sends every overseas order tracked, when untracked is roughly a quarter
of the price and is what most of these destinations should be defaulting to.

The real fix is the weight-banded per-country rate table that replaces it.

## Verified

`commerce-pricing` and `first-order-discount` suites pass, including three new
cases: the threshold applying inside its country list, not applying outside it,
and an empty list still meaning "everywhere".
