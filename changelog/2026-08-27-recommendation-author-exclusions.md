# Never recommend a book with no author, and stop same-titled books slipping past exclusions

**Date:** 2026-08-27

## What changed

Two tightenings to what the AI recommendation pipeline is allowed to return.

**1. Books with no named author are no longer recommended.**

The catalogue has real gaps: some rows arrive from the ONIX feeds with no A01
(primary author) contributor at all, or with a contributor row whose name is
blank. Until now nothing stopped those rows being recommended — authors were
only looked up *after* candidate selection, purely to give Gemini context for
the explanation text, so a book with no author simply came back with an empty
author list and was shown anyway. To the reader that's a cover, a title, and a
blank where the author should be: it reads as a broken record rather than a
suggestion.

A named-author requirement now applies to both places a recommendation is
produced:

- the quiz/refresh pipeline (`buildBaseConditions`), covering both the guest
  onboarding run and a signed-in reader retaking the quiz
- the unprompted recommendation email (`pickUnsentRecommendation`) — the one
  surface where the pick arrives without the reader asking for it, so a
  broken-looking record has nowhere to hide

**2. A same-titled book with no known author is now excluded too.**

The exclusion rule was already work-level rather than ID-level: rejecting a
paperback also suppressed the hardback and the ebook, matching on normalized
title *plus* primary author. The hole was what happened when the author on the
candidate side was missing. If a reader told us they'd read "Half of a Yellow
Sun", a *second* catalogue row with the same title but no A01 contributor did
not match the author check, so it survived the filter and could be recommended
straight back to them.

The rule is now: a candidate is excluded when its title matches and any of

- the rejection has no author recorded, or
- **the candidate has no author recorded** (new), or
- the two authors match.

Only a same-titled book by a *known, different* author survives — which is the
case worth protecting, since distinct books do legitimately share a title.

## Where it applies

Both halves of the rule live in `src/lib/exclusions.ts` and are shared, so this
covers every source of exclusions at once — books named in the quiz as already
read, books swiped away, and books already on the shelf — across the
recommendation pipeline, the personalized feed, and the recommendation email.
The in-memory twin used by the shared "you may also like" cache
(`filterExcludedWorks`) got the identical branch; that pair has to agree, or a
book gets excluded from one surface and not another.

## Non-obvious decisions

**Title-only matching was considered and rejected.** The strongest version of
this would drop any same-titled book regardless of author. That over-fires
badly on common titles — "Home", "Persuasion", "Twilight" — and would suppress
genuinely unrelated books by other authors. Matching on title with the author
allowed only to *rescue* a candidate (never to let one through on a
technicality) gets the reported behaviour without that cost.

**Both filters are WHERE predicates, not post-filters.** Dropping rows from the
result array afterwards silently returns a short list; a predicate lets the
similarity search top itself back up to the 100-result target.

**A translator credit does not count as an author.** A row whose only
contributor is a B06 translator counts as having no author, which means it now
falls into the looser title-only branch. This flips one existing test's
expectation — deliberately, and for the same underlying reason the test was
written: a non-A01 name is not an author, so it can neither match nor rescue.

## Not in scope

No free-text title input was added. Every "book I've read" reaches the backend
as a catalogue ID (the UI is search-and-select), so there is nothing to exclude
that isn't already anchored to a real row. If the UI ever lets someone name a
book that isn't in the catalogue, that needs a new field on the request body,
`guest_sessions` and `user_preferences`.

## Verification

`npx tsc --noEmit` clean. `src/__tests__/exclusions.test.ts` extended and
passing (16 tests) — new coverage for the untagged-candidate branch, for the
named-author condition, and for the case that must *not* change (an unrelated
untagged book is still kept, since the looser branch only fires on a title
match). Full suite: 399 passing; the 3 failures in
`subscription-pricing.test.ts` pre-date this change and are unrelated (Stripe
config not set in the local env) — confirmed by stashing these edits and
re-running.
