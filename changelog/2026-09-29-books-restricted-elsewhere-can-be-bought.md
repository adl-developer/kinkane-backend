# Books restricted only in other countries can now be bought

**Date:** 2026-09-29

## What changed

Gardners marks some books as restricted by market. An `N` row means "not for
sale in this region" and a `Y` row means "for sale only in these regions".
Add-to-cart checks these against the delivery country, but the country →
Gardners region mapping it needs (`GARDNERS_REGION_BY_COUNTRY`) was empty. With
no mapping, every book with **any** restriction row was refused for **every**
country.

There is now a built-in mapping for all 241 countries in the `countries`
table, so a restricted book can be bought wherever it isn't actually
restricted.

## The mapping

Gardners restricts by its own regions, not ISO countries. The mapping lives in
`src/services/commerce/gardners-regions.ts`, and each country maps to:

1. its own ISO code, because the feed also uses plain ISO codes (`US`, `GB`,
   `SG`…) and `UK`;
2. its Gardners country code, if Gardners has one (`USA`, `UKI`, `FRA`…);
3. every Gardners aggregate that contains it: `AFR`, `EUR`, `FAR`, `MID`, `IND`,
   `SAM`, `WIN`, `BAL`, `YUG`.

Examples: Ghana → `AFR|GH`; United States → `US|USA`; United Kingdom →
`GB|UK|UKI`; France → `EUR|FR|FRA`.

Gardners doesn't publish which countries each aggregate contains, so the
memberships are geographic. A few calls were made deliberately and are
documented in the file:

- **The UK is not in `EUR`.** 8,018 titles are "Europe only" (`Y EUR`). In
  publishing that is usually an export edition not for UK sale, so putting the
  UK in Europe would make all of them sellable there.
- **Ireland is `EIR` + `EUR`, not `UKI`.**
- **Egypt is in both `AFR` and `MID`**, and US territories are `USA` only.

`GARDNERS_REGION_BY_COUNTRY` still works and now overrides individual
countries without a deploy. **These memberships should be confirmed with
Gardners.**

## Effect at add-to-cart

In the local catalogue, 22,571 books have restriction rows. For a Ghanaian delivery
address only 84 of them are now refused. The rest were blocked before and are
buyable now. Most are "not for sale in the USA" titles.

The shop listing uses the same mapping to rank books that are restricted in
the customer's own country lower. See
`2026-09-29-shop-hides-unsellable-books-restricted-titles-last.md`.

## How it was verified

- Unit tests pin the mapping's shape: every one of the 241 countries is
  present, each includes its own ISO code, only ISO or Gardners codes are used,
  and the UK stays out of `EUR`.
- Against the local database, the restriction rule was applied to all 22,571
  restricted books for 12 countries. Books refused: Ghana 84, Nigeria 84,
  Kenya 84, UK 122, France 27, Ireland 27, South Africa 86, Japan 23, India 55,
  Brazil 7, Australia 34, USA 22,213.
