# Referral stats now return camelCase keys

**Date:** 2026-08-11

## What changed

`GET /api/v1/referrals/me/stats` was returning the `pointsByKind` breakdown with
snake_case keys, alone among every response this server sends:

```json
"pointsByKind": {
  "same_country": 0,
  "indirect_cross_continent": 0,
  "full_circuit": 0
}
```

It now returns:

```json
"pointsByKind": {
  "sameCountry": 0,
  "sameContinent": 0,
  "crossContinent": 0,
  "indirectSameContinent": 0,
  "indirectCrossContinent": 0,
  "fullCircuit": 0
}
```

Nothing else about the endpoint changes — same values, same totals, same
`hasCircuit`.

## Why it happened

Those keys were not written by hand anywhere. They were the values of the
`referral_point_kind` Postgres enum, flowing straight from a `GROUP BY kind`
into the response object. Every key the controller writes literally
(`countriesReached`, `hasCircuit`, `pointsByKind` itself) was already camelCase
— this one object was built dynamically from database identifiers, so it
inherited the database's naming convention and no one had to type it.

That is worth noting because it is the shape of the bug rather than the bug
itself: any response assembled from column or enum names will do the same thing.

## How it is fixed

A single translation map, `POINT_KIND_JSON` in
[referral-scoring.service.ts](../src/services/referral-scoring.service.ts).

The Postgres enum **stays snake_case**. It is idiomatic there, it is what the
migrations and every query already read, and renaming it would mean an enum
migration plus a rewrite of the ledger's partial unique index — all to satisfy a
convention that only applies at the API boundary. Both conventions are correct in
their own layer; the translation now happens in exactly one place.

The map is declared `as const satisfies Record<ReferralPointKind, string>`, which
is load-bearing: `satisfies` forces it to cover every enum member, so adding a
new point kind without giving it a JSON name **fails the build** rather than
silently returning an object with a missing key. The `as const` preserves the
literal types, so `PointsByKind` is a precise type rather than
`Record<string, number>`, and `byKind.fullCircuit` is checked rather than assumed.

## Compatibility

**This is a breaking change for any client already reading `pointsByKind`.** It
ships now because the feature has not been released — the migration that creates
these tables has not been run against production, so no client can be reading
these keys yet. It would be considerably more expensive to change later.

## What was checked

The full response body was rendered and asserted to contain no snake_case keys
at all, not just in `pointsByKind`. Every other referral response was also
scanned for snake_case keys in its literals; there were none, so this was the
only place affected.

Two new tests guard the map: every JSON name must match camelCase, and the map
must cover every awardable kind with no duplicate values. The duplicate check
matters because two kinds sharing a JSON name would silently merge into one key
and the totals would still add up — nothing else would catch it.

150 tests, 147 passing. The 3 failures in `subscription-pricing.test.ts` are
pre-existing on `main` and unrelated.
