# Match contributor names on a normalised form, and score the fuzzy tier

**Date:** 2026-08-25

## What changed

Two fixes to name search, both about matches that existed but could not be
reached.

**Whitespace.** Contributor names arrive from the ONIX feeds with doubled
internal spaces — "Catherine  Eschle", "Christine  McLaughlin", "David
Peace". That is 27,428 of 126,664 contributor rows (21.7%), 20,916 distinct
names, across 17,718 books. More than half are `A01` primary authors
(15,470) rather than editors, so this degraded ordinary author search, not
only the edited-volume case fixed earlier the same day.

The prefix tiers compare with `LIKE`/`ILIKE`, which are literal: one space
typed against two stored is not a match, and the trigram index does not
rescue it — the index only pre-filters, and the recheck runs against the raw
string. Both sides of the comparison are now normalised (repeated whitespace
collapsed, ends trimmed), and the two name indexes are built over the same
normalised expression.

**Scoring.** The fuzzy tier had no score, so every fuzzy match tied on tier
and the sort fell through to title order. A name matching at
`word_similarity` 1.0 therefore landed wherever the alphabet put it —
measured, "Christine McLaughlin" sat past position 50, behind "100
Buttercream Flowers" and "4.50 from Paddington". Each union branch now
carries a score, and ranking is `(tier, score DESC, title, id)`.

## The non-obvious decisions

**Normalise the comparison, not the stored data.** A backfill over the 27,428
rows was the alternative. Rejected: the ingested value is a faithful record of
what the supplier sent, and once overwritten there is no way to tell a genuine
name from a repaired one. It also leaves the ingester no whitespace policy to
guess at for future feeds.

**One shared expression, in `lib/contributor-name.ts`.** An expression index
only serves a query whose expression matches it *exactly*. A one-character
drift between the index definition and the query is not an error — it is a
silent sequential scan over the whole contributor table, which is the cost
this search exists to avoid. Both sides therefore read from one constant
rather than spelling it out twice.

**The `\s` trap.** In a JavaScript string literal `'\s'` is not a recognised
escape and collapses to a bare `'s'`, which turns the whitespace-collapsing
expression into one that deletes every "s" from every name. It is not a syntax
error at any layer: it fails quietly and returns plausible-looking wrong
matches. This was hit for real while developing the change — a probe returned
`catherine  e chle` — and is now pinned by a test that normalises a name
containing an "s".

**The exact tiers score a constant 1 rather than a computed similarity.** They
are all equally exact, and `word_similarity()` per row is the expensive part;
the cheap tier must not acquire it as a side effect of scoring. A test asserts
the cheap tier emits no `word_similarity` at all.

**The index change was folded into the widened indexes rather than added
after them.** Those indexes had not been built on production yet, so amending
their definitions avoids building expression indexes twice on a
multi-million-row table.

## Not in scope

The raw value is still what the app renders, so a name filed with two spaces
still *displays* with two spaces. Normalising for display is a separate
decision — at render time, or on ingest with a backfill.

Search pagination can also return the same book on two different pages
(`q="roald dahl"`, limit 10, offsets 0/10/20 → 10 duplicate ids). Confirmed
pre-existing and unrelated: identical counts before and after these changes.
Tracked separately.

## How it was verified

Against the local catalogue, all of these now return the correct book at
position 1, where the single-space spellings previously returned nothing
relevant in the top 50:

    "Catherine Eschle"  /  "Catherine  Eschle"
    "Christine McLaughlin"  /  "  Christine   McLaughlin  "
    "Rossen-Knill"        (an "s" name, against the escaping trap)

Typo'd author queries now resolve through the scored fuzzy tier —
"chimamnda ngozi adichie" and "adiche" both return Adichie's own books at
positions 1-4, where the ranking previously buried them alphabetically.

Page-overlap was re-checked at offsets 0/10/20 and is byte-identical to the
previous commit, confirming the new sort key did not disturb the existing
prefix-of-the-next-sample property.

The index build itself could not be applied locally — schema DDL was blocked
in the working environment — so the index definitions are reasoned from the
expression rather than confirmed by EXPLAIN. Run `npm run db:init` and check
the plan before relying on the performance characteristics.
