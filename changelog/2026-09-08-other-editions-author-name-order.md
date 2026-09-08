# Find other editions when an author's name is stored back to front

**Date:** 2026-09-08

## What changed

The `otherEditions` list on `GET /api/v1/books/:id` now matches a shared
author whichever way round the feed stored their name. Before this, it
compared only `book_contributors.person_name` on each side, so two editions
of the same book credited to the same person could still find each other
only if both records happened to spell the name in the same order.

They frequently don't. Verified against production on 2026-09-07 — two
Penguin editions of *Things Fall Apart*, identical title, identical
publisher, same author, both returning `otherEditions: []`:

| book id | `person_name` |
| --- | --- |
| 1263015 | `Chinua Achebe` |
| 1429568 | `Achebe, Chinua` |

`book_contributors` already carries both spellings — `person_name` and
`person_name_inverted` — because the ONIX feed supplies both. Records just
aren't consistent about which order lands in which column. So each side of
the comparison now contributes **both** of its stored spellings, and a hit
on any pairing counts: the natural-order row matches on its own inverted
form, which is the spelling the other row kept.

## Why not looser matching

Two alternatives were considered and rejected:

- **Canonicalising to a sorted token set** ("achebe chinua" either way
  round) would also work, and would additionally survive punctuation drift.
  It was rejected as more machinery than the problem needs: it can match two
  genuinely different people whose names are token-order permutations of
  each other, and under this database's `C` ctype the obvious
  accent-stripping regexes behave inconsistently on non-ASCII names (see
  the note in `lib/contributor-name.ts` about how quietly these expressions
  fail). Comparing the two spellings the publisher actually supplied keeps
  the match faithful to the source data.
- **Dropping the exact-publisher requirement**, which is the other reason
  real sibling editions go unmatched (formats are often issued under
  different imprints, and a large slice of the catalogue carries the
  placeholder publisher `Not Stated`). Deliberately left alone here — it is
  a precision/recall tradeoff on the catalogue rather than a defect, and it
  deserves its own decision.

The generic-credit guard (`GENERIC_CONTRIBUTOR_NAMES` — "UNKNOWN",
"VARIOUS", "ANONYMOUS" and friends) applies to both spellings, so nothing
about the earlier false-positive protection is weakened.

## What is verified, and what isn't

Verified:

- The rule itself, run against the two real production spellings: the old
  comparison returns `false`, the new one returns `true`.
- No regression on local data — the placeholder cluster
  (`SOS TITLE UNKNOWN` / `Not Stated` / `UNKNOWN`) still returns
  `otherEditions: []`, and a known multi-volume series still returns its
  siblings.
- Typecheck clean; the books-service test suite (93 tests) passes.

**Not** verified: that `person_name_inverted` is reliably populated in
production. It is populated on 126,664 of 126,664 rows in the local dev
database, which is suggestive but is a different and much smaller dataset.
An attempt to confirm this directly against the production database was
inconclusive and then blocked, so it remains an assumption. The cheap
post-deploy check is `GET /api/v1/books/1263015` — `otherEditions` should
now contain `1429568`. If it doesn't, this fix has not taken effect and the
inverted column is the thing to look at.

No automated test covers `fetchOtherEditions` yet; there is still no fixture
dataset with a known multi-edition title to assert against.
