# Stop the quiz showing the same book twice under slightly different titles

**Date:** 2026-09-26

## What changed

Quiz results (onboarding and retakes) used to treat two catalogue rows as the
same book only if their titles matched exactly, ignoring case and surrounding
spaces. Feeds spell titles inconsistently, so one book could appear twice in
one results list:

- "The Green Mile" and "Green Mile"
- "The Grapes of Wrath" and "Grapes of Wrath"
- "Goodbye, Eastern Europe" and "Goodbye Eastern Europe"

Two editions now count as the same book when their titles match after
folding case, accents, punctuation, "&"/"and", and a leading or trailing
"the"/"a"/"an", **and** their first-listed author matches after the same
folding. The best edition of each book is still chosen by the existing rules
(in stock, then paperback, then has a cover, and so on). This applies to both
the close-match tier and the backfill tier of the similarity search.

Keying on the author also fixes the opposite problem. Different books that
share a title used to be collapsed into one card, for example the separate
*Odyssey* retellings by Geraldine McCaughrean, Gillian Cross and Louie
Stowell. They now appear separately.

New helpers in [lib/dedupe.ts](../src/lib/dedupe.ts): `normalizeWorkText`,
`workKey`, `dedupeByWork`. They're used in `fetchCandidateBooks` in
[recommendations.service.ts](../src/services/recommendations.service.ts). This
adds one batched author lookup per uncached quiz request.

## Decisions

- **Subtitles are not stripped.** I measured this across the 83,688-book
  catalogue:
  - Folding plus author merged 125 groups, and every one sampled was a true
    duplicate.
  - Also cutting titles at ":" or " - " merged 832 groups. Most of those were
    distinct books in a series by the same author ("Deadly! Irish History -
    The Vikings" / "- The Celts", "Mistborn" / "Mistborn: Secret History").
- **The "already read / rejected" exclusion is unchanged.** It still matches
  on `trim + lowercase`. That comparison runs in SQL against normalised
  titles stored on every dislike, so changing it means rewriting the SQL
  predicate and backfilling `user_disliked_books`. That's a separate change.
- **Other surfaces are unchanged.** Other feeds that use `dedupeByTitle` keep
  their current behaviour. This change covers the quiz only.

## Known gaps

- Author spelling variants of one book still come through as two books,
  e.g. "Dostoevsky" / "Dostoyevsky", or "Homer" / "Homer Homer".
- A book whose feed title carries a subtitle one edition lacks ("White Bird"
  / "White Bird: A Novel") is still treated as two books. This follows from
  the subtitle decision above.

## Verification

- New unit tests in `dedupe.test.ts` cover the normalisation cases,
  same-title/different-author, and best-edition selection under the new key.
  The full unit suite passes (1029 tests).
- Read-only check against the live catalogue: for five seed books, I took the
  150 nearest neighbours of each seed's embedding. Every seed's neighbourhood
  had at least one pair that the old dedup would have shown twice, for
  example "The Odyssey | Odyssey" and "Return of the Native | The Return of
  the Native". The new key collapses each of these pairs.
