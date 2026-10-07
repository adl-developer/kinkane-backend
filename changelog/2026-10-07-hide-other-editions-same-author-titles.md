# Books you picked stop coming back as another edition or a same-author title

**Date:** 2026-10-07

## What changed

The rule that keeps a book out of your recommendations once you've picked it,
shelved it or passed on it now catches two more cases.

1. **Editions with a format tag.** Some supplier titles end in `PB`, `PBK`,
   `HB` or `HBK` ("AMERICANAH PB"). That tag is now ignored when titles are
   compared, so picking "Americanah" also hides "AMERICANAH PB". About 1,600
   catalogue titles end this way.
2. **Same author, one title inside the other.** A book is now hidden when it
   has the same author as a book you've excluded and either title contains
   the other word for word: "Dune" and "Dune Messiah", "Bel Canto" and
   "Bel Canto Arias for Soprano".

The rule is shared, so this applies everywhere it's used: quiz results, the
home feed, recommendation emails and "you may also like".

## Why

A reader picked "Americanah" during onboarding and was then recommended
"AMERICANAH PB", the same book under a supplier title. Separately, the
product decision was to treat a same-author title that contains the picked
one as close enough to skip.

## Decisions

- **No similarity score.** Trigram similarity was measured again and can't
  separate editions from different books: "americanah / americanah pb"
  scores 0.79, but "workbook with key / workbook without key" scores 0.76.
  Whole-word containment with the same author is exact and predictable.
- **Sequels are now hidden on purpose.** Reading "Hedgewitch" hides
  "Hedgewitch: Stonewitch", and "Dracula" hides "Dracula's Guest". Earlier
  tests kept these; they were changed to the new behaviour.
- **Short titles are left out.** The shorter title must be at least 4
  characters, so a book called "It" doesn't hide every title by that author
  that uses the word.
- **Both authors must be known.** A missing author never triggers the
  containment rule. The existing exact-title rule still handles unknown
  authors as before.
- **Volumes still decide identical titles.** If two titles differ only in
  volume number, the volume check applies, so "Tokyo Ghoul (Vol. 3)" doesn't
  hide "(Vol. 9)".
- **Cached quiz results are retired.** `WORK_MATCH_VERSION` went from 2 to 3.
  Cached home feeds pick up the change within their 1-hour expiry.

## Out of scope

The one-edition-per-book step in lists (`lib/dedupe.ts`) already ignored
`PB`/`HB` and is unchanged. It does not apply the containment rule, so a list
can still show "Dune" and "Dune Messiah" together when you've excluded
neither.

## Verification

- Unit tests cover the format tag, containment, short titles, unknown
  authors, different authors, part-word matches and volumes.
- The contract test runs the SQL version of the rule and the TypeScript
  version against the same fixture books in Postgres and checks they keep
  exactly the same books.
- Timed read-only over 300,000 catalogue rows: the new check added no
  measurable time.
