# The genre question now finds novels, and the cutoffs mean something again

Two follow-ons from building the books lane out of stored book embeddings. Both
were found by measuring against the local catalogue rather than by reading code.

## The genre lane was searching literary criticism

The lane asked Gemini to embed:

    Preferred genres: romance, crime.

which reads like a sentence from a genre-studies paper — and that is what it
found. Measured against the catalogue, the nearest books to that vector were
*Persuasion in Specialised Discourses*, *Phraseology and Style in Subgenres of
the Novel*, *The Stylistics of Humour* and *Cross-Cultural Perspectives on
Gangs*. Academic works about romance and crime as categories, not romances and
crime novels.

A bare list (`romance, crime.`) is no better, and for the same reason: a
scholarly work's subject headings look exactly like it, so the vector lands
among criminology handbooks.

What fixes it is anchoring the list to a book somebody would actually read:

    romance, crime. A book to read.

Same words, plus four that say "this is a book, not a field of study". The
nearest books become *The Da Vinci Code*, *The Godfather*, *Beach Read*, at a
distance of 0.277 against the old 0.341. Isolating the lane on the quiz's own
genre values now returns *Beach Read*, *Charming the Shortstop* and *Christmas
at the Comfort Food Cafe* where it used to return stylistics monographs.

`Fiction.` scores a hair better on fiction genres (0.276) and was the obvious
candidate, but the quiz vocabulary also carries business, politics, travel,
biography and self-help, where it drags towards academic monographs. The
neutral anchor is within 0.001 on fiction and clearly better on the rest, so it
wins on the vocabulary as a whole rather than on its best case.

This mattered most to the mood-led weighting, which leans on the genre lane
hardest.

## The candidate cutoffs had stopped excluding anything

`RECO_SIMILARITY_MAX=0.5` and `RECO_BACKFILL_MAX=0.7` were tuned when the books
lane embedded titles. Title vectors sit far from everything in the catalogue,
so 0.5 was a real boundary — it admitted 58% of the catalogue, and the backfill
tier existed for readers who fell short of it.

A centroid of real book embeddings lands in the dense middle of the space
instead. Measured for one reader, the same 0.5 admitted **99.7%** of the
catalogue. The strict tier had quietly become "every book", and the backfill
tier could never fire.

Nothing was returning wrong results — ranking is by raw distance either way —
but the tiering had stopped doing its job, and a reader whose taste matches
nothing in the catalogue would still be served a full page of results that look
exactly as confident as a good match.

Re-measured across eight synthetic readers (each a seed book plus its four
nearest neighbours, so the taste is coherent by construction), on the 83k local
catalogue:

| rank | distance |
|---|---|
| 100th nearest | 0.205 – 0.231 |
| 300th nearest | 0.218 – 0.245 |
| 1000th nearest | 0.236 – 0.266 |
| 5000th nearest | 0.266 – 0.299 |

The pool is 300 books, so the strict cutoff wants to sit just above the 300th
nearest: a typical reader then fills the pool with strict matches, and an
unusual one falls short and the backfill does what it was built for.

- `RECO_SIMILARITY_MAX=0.25` — above every reader's 300th-nearest, while
  admitting only ~1-3% of the catalogue. The strict tier for the reader in the
  earlier write-up went from "more than 5000" to 2,439.
- `RECO_BACKFILL_MAX=0.32` — around the 5000th nearest, far enough to fill the
  pool for a reader whose strict tier came up short, without reaching back to
  everything.

## A guard, so this cannot happen quietly again

The two settings are coupled to how the books lane is built, and nothing in the
code said so. Enabling the new lane and forgetting the cutoffs is an easy
mistake with no symptom — the app works, the tiering just stops meaning
anything.

Boot now warns when `RECO_BOOKS_FROM_EMBEDDINGS` is on and
`RECO_SIMILARITY_MAX` is still at a titles-era value. A warning rather than an
exit: the search genuinely still works, so refusing to start would be out of
proportion.

The zod defaults stay at 0.5/0.7. They describe the behaviour of an environment
that has opted into nothing, and `retrievalFingerprint` uses them to recognise
an untouched environment and keep its cache warm.

## What was left out

The mood lane has the same class of problem and is not fixed here. Asking to
feel "comforted, hopeful, uplifted" returns *Man's Search For Meaning* and
*Communication at the End of Life* — books *about* hope and comfort, several of
them palliative-care textbooks, rather than books that feel hopeful to read. No
phrasing fixes that, because an embedding of a blurb encodes subject matter far
more strongly than affect. Mood belongs in a re-ranking stage with extracted
tone facets, which is its own piece of work.

## How it was verified

Both changes were measured, not reasoned about.

**The cutoffs, through the live endpoint.** `scripts/reco-tier-probe.ts` sends
real quiz answers to `POST /api/v1/recommendations` and measures how far every
returned book sits from the reader. At 0.25/0.32 a typical reader got 100
results, all strict matches, the furthest at 0.222. With the strict cutoff
squeezed to 0.15 so that no book qualified, the endpoint still returned a full
100 — every one from the backfill band, none beyond it. That second tier could
never be reached under the old 0.5.

One finding worth recording: a deliberately incoherent reader (five unrelated
books) did *not* produce a sparse strict tier — it produced 15,758 strict
matches against 2,343 for a coherent one. Averaging unrelated books lands in the
generic middle of the space, which is the densest part. So the cutoffs cannot
catch a reader whose picks don't cohere; that needs the multi-modal work.

**Unit tests.** `preference-lanes.test.ts` checks the genre clause that actually
reaches Gemini is `romance, crime. A book to read.`, and a source-level test
stops the old phrasing coming back. `reco-config.test.ts` boots the config and
checks the cutoff warning fires with the new lane on and 0.5 or 0.4 left in
place, and stays quiet at retuned values or while the titles lane is still in
use. Each was confirmed to fail with its behaviour broken on purpose. Full suite
green (862 tests), typecheck clean.

**Running the probes elsewhere.** `scripts/reco-cutoff-probe.ts` picks its
eight seed books as a deterministic sample of whatever catalogue it runs
against, so it means the same thing on production. It is the thing to run there
before setting these values — distances at a given rank shrink as a catalogue
grows, and production carries ~1.1M books against the 83k these came from.
