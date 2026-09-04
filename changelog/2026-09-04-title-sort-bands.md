# Titles starting with numbers or symbols now sort to the bottom

**Date:** 2026-09-04

## What changed

Browsing the catalogue A–Z (`GET /books?sortBy=title`) used to open on rows
nobody is looking for. Plain text sorting puts punctuation and digits ahead of
every letter, so the first pages were `1984`, `!Huracanes!`, `100 Best
Recipes`, `?` — before a single book beginning with "A".

The ordering now sorts titles into three bands, and only then alphabetically
within each:

| band | titles | examples |
| --- | --- | --- |
| first | starts with a letter | `A Bad, Bad Place`, `"The Nose"`, `#Girlboss`, `Élégance` |
| then | starts with a digit or a symbol | `1984`, `£10 Dinners`, `!Huracanes!` |
| last | nothing but punctuation, or no title at all | `?`, `.`, `...`, `-` |

The bands stay in that order whichever way the page is sorted: Z–A reverses
the alphabet, not the bands, so the junk never floats back to the top.

## Titles that start with a quote or a hash

`"The Nose"`, `'Tis the Season`, `#Girlboss` and `¿Quién?` all start with
punctuation, but they are real books, not placeholders — quoted titles alone
turn up four times in a 1000-row sample of the live catalogue. They stay in the
first band: leading quotes, apostrophes, `#`, `¡¿` and spaces are ignored when
deciding which band a title belongs to.

They are also *alphabetised* on the same ignore-the-decoration basis, and that
second half matters as much as the first. Ranking `"Brother Woodrow"` as a real
book while still alphabetising it on the raw text only moves the problem from
the bottom of the page to the top — `"` sorts below every letter, so page one
of A–Z came back as eight `"…"` titles in a row. Ignoring the quote files it
under B, where a reader would look for it. Where two titles differ only in
their decoration, the raw title breaks the tie, so paging through gives a
stable order rather than an arbitrary one.

A title that genuinely opens on a symbol — `£10 Dinners`, `(Un)Common`,
`!!! Wow` — is not rescued this way, and sinks. That is the behaviour that was
asked for.

## Accented and non-Latin titles

The band is decided with an explicit Unicode collation (`und-x-icu`) rather
than the database's own character rules. This is not a detail: the database is
created with ctype `C`, under which Postgres does not consider `É` a letter at
all. Without the collation, `Élégance`, `Öl und Wein`, `Čapek`, `Москва` and
`東京` would all have been treated as symbol-led and pushed to the bottom, and
a title made only of accented characters would have counted as junk. It also
means the banding cannot come out differently on two environments whose
databases were created with different settings.

It does require a Postgres built with ICU. If the collation is missing, the
migration fails outright rather than banding titles wrongly and quietly.

## Performance

The catalogue is ~2M rows, and an ordering that no index can satisfy makes
every browse page sort the entire filtered table before returning 20 rows.
Migration `0061` replaces the two indexes added by `0056` with two that lead on
the new ordering, and the deploy builds them `CONCURRENTLY` beforehand so the
ONIX pipeline and Gardners feed runs are never stalled behind a lock. Both
directions were confirmed on a development catalogue to run as an index scan
with no sort step.

The new indexes are deliberately given **new names**. `CREATE INDEX IF NOT
EXISTS` matches on name, not definition — reusing the old names would have
found the old indexes, skipped the create, and left the page sorting the whole
catalogue on every request with nothing logged anywhere. The old pair is
dropped, since it answers no query now and still costs every write.

## Left out of scope

- **Shelf and reading-list sorts** (`GET /users/:id/books`, saved books) still
  order on the raw title with no banding. They are small, per-user lists where
  the problem does not really arise; making them match would be a separate
  change.
- **Search results** are unaffected — relevance ranking wins there, as before.
- **Damaged source data.** A number of Spanish titles have arrived from the
  feed with `¡` mangled into `!` (`!Huracanes!`, `!Patea, Pipo!`), so they band
  as symbol-led. That is an encoding problem in ingestion, not a sorting one,
  and fixing it here would have meant treating a real `!` as decoration.
  Similarly, a handful of rows have titles that are literally `?` characters
  where non-Latin text used to be.

## How it was verified

- The band expression was run against Postgres over 32 hand-picked titles
  covering each band, accented and non-Latin scripts, decorated titles, empty
  strings and NULL. Checking against the real database is what caught the
  ctype problem above — reasoning about the regex alone had it wrong.
- Band counts over the development catalogue: 83,058 letter-led, 629
  digit/symbol-led, 1 placeholder.
- `EXPLAIN` on both sort directions shows `Index Scan using
  idx_books_title_band` / `_desc` with no `Sort` node, and the head and tail of
  the page were read back to confirm the bands land where intended.
- `title-sort-placeholders.test.ts` asserts the expression is character-
  identical across the service, the migration and the pre-build script, so a
  future edit to one copy fails the suite instead of silently disabling the
  index.
