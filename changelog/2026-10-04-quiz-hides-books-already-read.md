# Keep every edition of a book you've already read out of your quiz results

**Date:** 2026-10-04

## What changed

When you name a book you've already read in the quiz, no edition or spelling of that book is recommended back to you. Before, only the exact catalogue row and editions with an identical title were removed. "Bel Canto: A Novel", "Bel Canto (Harper Perennial Modern Classics)" and "Bel Canto [Large Print]" could all still appear after you said you'd read *Bel Canto*.

Other books by the same author are **not** removed. Naming *Bel Canto* removes every edition of *Bel Canto*, but Ann Patchett's *Whistler* and *The Magician's Assistant* can still be recommended. A different book that shares the title, such as Robert Toft's *Bel Canto: A Performer's Guide*, is also kept.

The same matching is shared by every place that hides books you've read, rejected or already own: quiz results and retakes, the home feed, "you may also like", the readers-like-you rail and recommendation emails.

## How "the same book" is decided now

A candidate book is hidden when its **title matches** and its **author doesn't contradict it**.

**Titles match** when they are equal after ignoring:
- case, punctuation, "&" vs "and", and a leading or trailing "The"/"A"/"An" (as before);
- bracketed text after the title, e.g. "(Movie Tie-in)" or "[Large Print]";
- a subtitle after `: ` or ` - `, removed from **one** of the two titles only. "Bel Canto: A Novel" matches "Bel Canto", but "Warriors: Fading Echoes" does not match "Warriors: A Warrior's Choice".

Any volume numbers in the two titles (digits up to three long, or Roman numerals such as II or XIV) must also be the same. So "Tokyo Ghoul (Vol. 3)" and "Tokyo Ghoul (Vol. 9)" stay separate even though their brackets are ignored.

**Authors** are compared after collapsing doubled spaces, turning full stops into spaces, and flipping "Patchett, Ann" to "Ann Patchett". Suffixes like "King, Jr." are not flipped. As before, a same-titled book by a *known, different* author is kept, and a missing author on either side lets the title decide on its own.

A book you named with several authors now counts for each of them, so an edition credited to only one co-author still matches.

## Non-obvious decisions

- **No fuzzy similarity score.** The first plan used pg_trgm title similarity. Measured across the catalogue, every cutoff from 0.6 to 0.95 mostly matched *different* books by the same author: "Theory A" vs "Theory B", "Workbook with Key" vs "without Key", "Vol. 3" vs "Vol. 9". Exact matching on the cleaned-up titles catches the real edition variants without those mistakes. The cost is that typos in catalogue titles are not caught.
- **Subtitles are only removed from one side.** Removing them from both titles merged 15,609 pairs of books by the same author, almost all of them different books in one series ("Oxford Reading Tree: Level 6: …", "Warriors: …").
- **Author clean-up was needed for the existing rule too.** About one author name in five in the catalogue has a doubled space, and 752 authors are stored under more than one spelling. The old exact comparison treated those as different people, so some editions already slipped through.
- **It errs towards hiding.** On the local catalogue the new rule matches 739 more pairs of books by the same author than the old one did. In a sample of 40, most were genuine editions; about 1 in 10 was a related but different book, such as the sequel *Hedgewitch: Stonewitch*. Hiding one extra book costs little; recommending a book you said you'd read makes the quiz look like it isn't listening.

## Caches

- Quiz results are cached for 48 hours under a key that now includes a match-rule version, so lists filtered under the old rule are not served again.
- The home feed cache prefix moves from `personalized:v5` to `personalized:v6` for the same reason.

## Performance

The filter runs as a Postgres predicate. With 200 excluded books it took about 630ms over the whole 83k-book local catalogue, against about 310ms for the old rule (roughly 7.5µs per book). The quiz search uses pgvector's iterative index scan, so in practice the filter only runs on the rows the index returns.

## How it was verified

- **TypeScript and SQL agree.** The title and author clean-up exist twice, once in TypeScript and once in SQL. Across the local catalogue the two agree on all 83,706 titles and 88,395 author names.
- **Same books removed.** With 301 excluded books, Bel Canto / Ann Patchett among them, the SQL filter and the in-memory filter remove exactly the same 380 of 83,688 books.
- **Unit tests.** New cases cover the Bel Canto variants, author spellings, series titles, volume numbers and co-authored books. The full suite passes (1,195 tests).

## Out of scope

- Fixing the doubled spaces in stored author names at the source (the ONIX ingester).
- Catching typos in catalogue titles.
- The readers-like-you rail still groups editions on the plain title fold for display; only its filtering uses the new rule.
