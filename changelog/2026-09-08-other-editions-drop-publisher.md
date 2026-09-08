# Stop requiring the same publisher to link other editions of a book

**Date:** 2026-09-08

## What changed

`otherEditions` on `GET /api/v1/books/:id` previously required a candidate to
share the book's exact title, at least one contributor, **and** its exact
publisher. The publisher condition is gone; the match is now exact title plus
a shared identifying contributor.

The publisher rule looked reasonable and was quietly disastrous for the most
recognisable titles. Reported case — book 5007, *Animal Farm*, Nick Hern
Books — returned an empty list. Eight other rows shared its exact title and
credited George Orwell, and all eight were rejected solely for carrying a
different publisher:

| id | format | publisher |
| --- | --- | --- |
| 42513 | **BB hardback** | Pan Macmillan |
| 42710 | BC | Oxford University Press |
| 43568 | BC | HarperCollins Publishers |
| 44309 | BC | HarperCollins Publishers |
| 46665 | BC | Faber & Faber |
| 51268 | BC | Birlinn General |
| 79278 | BC | Maple Press Pvt Ltd |
| 81155 | BC | Fingerprint! Publishing |

That is the normal shape of a reissued book, not an edge case: a work out of
copyright is published by many unrelated houses, hardback and paperback are
often split across imprints, and a large part of the catalogue carries the
placeholder publisher `Not Stated`. The rule guaranteed an empty list for
precisely the famous titles a reader is most likely to open.

## What still prevents false matches

The shared-contributor requirement, which is now doing all of the
discriminating work, plus the existing `GENERIC_CONTRIBUTOR_NAMES` denylist
so a shared credit of "Various" or "Unknown" never counts as identity.
Verified on local data:

- *Animal Farm* 5007 → 8 siblings, including the Pan Macmillan hardback.
- The placeholder cluster (`SOS TITLE UNKNOWN` / `Not Stated` / `UNKNOWN`)
  → still 0, even though the publisher condition used to help mask it.
- **Book 65900, also titled exactly "Animal Farm" but credited to Tanya
  Landman** (a retelling, no Orwell credit) → 0, and does not pull in any of
  the Orwell editions. This is the check that matters most now that
  publisher is gone.

## Two consequences worth knowing

- **Adjacent editions, not strictly format variants.** Among the eight
  matches for *Animal Farm* are a Collins GCSE study edition and an OUP
  annotated critical edition. All are genuinely *Animal Farm* by Orwell, but
  a client presenting this purely as "choose your format" will show some
  entries that are a different edition rather than a different binding. The
  client brief now says so.
- **Results are capped at 20** (`OTHER_EDITIONS_LIMIT`). Publisher used to
  narrow the candidate set; without it the candidates are every book sharing
  the title, and a placeholder title can be carried by thousands of rows.
  The cap bounds both the payload and the join.

## Coverage

Measured on the local dev database (83,688 live books) — the share of books
that come back with a non-empty `otherEditions`:

| | |
| --- | --- |
| Publisher required (before) | 11,008 (13.15%) |
| Publisher dropped (now) | 13,281 (15.87%) |

A modest headline move that is concentrated on heavily reissued titles, which
is where readers actually notice it.

## Verified

Typecheck clean; books-service suite (93 tests) passes; the four cases above
checked against the local database with the detail cache cleared first, so
none of them read a pre-change cached answer. Production was not measured —
this is not deployed yet, and there is no production database access from
this repo.
