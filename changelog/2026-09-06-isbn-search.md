# Searching by ISBN in the ordinary search box

**Date:** 2026-09-06

## What changed

`GET /books?q=` (and its v2 twin) now recognises when the query is an ISBN and
answers it as an exact lookup instead of a text search. `?q=9781529219173`
returns that edition and nothing else.

Recognised forms, all case- and punctuation-tolerant:

- 13 digits — `9781529219173`, `978-1-5292-1917-3`, `978 1 5292 1917 3`
- a valid ISBN-10 — `0306406152`, `080442957X` — converted to its ISBN-13,
  since the catalogue only stores ISBN-13

Everything else is untouched: a title, an author name, a partial ISBN, a query
with an ISBN embedded in a longer phrase, or a 10-digit number that fails the
ISBN-10 checksum all go to the search exactly as before. The response shape is
unchanged — an ISBN query returns the same listing envelope with one book in it.

## Why

The UI has one search box, and someone holding the book types the number off the
back of it. Before this change that number went through the catalogue's text
search: it matches no title, so the query walked the whole fuzzy ladder — prefix,
then trigram similarity, then full-text — across a ~2M-row table in order to
return nothing. It was simultaneously the slowest kind of request the endpoint
serves and a wrong answer for a customer who had told us exactly which book they
wanted.

The exact filter that answers it was already there: `?isbn=` has always existed
and matches on the unique index on `books.isbn13`. All that was missing was
noticing that `q` was one.

## How it is wired

A pure helper, `isbnFromQuery` in `src/lib/isbn.ts`, and one rewrite at the edge
of the request in `books.controller.ts`: when `q` parses as an ISBN, it is
dropped and `isbn` is set, and `booksService.list` is then called with the
ordinary ISBN-filtered options it has always accepted.

Doing it at the controller rather than inside the service is the whole reason
this is safe. The search path is not modified at all — no new branch inside the
tier ladder, no extra probe, no change to the ranking or to either cache key's
inputs. The service cannot tell an ISBN request apart from a hand-written
`?isbn=` one. It also lands on v1 and v2 together, since both share that handler.

Cost for a query that is *not* an ISBN: two regex tests against a string of at
most 200 characters, before any I/O.

## Decisions worth naming

**`q` is dropped, not kept alongside the filter.** Keeping it would AND a fuzzy
title match for the digits onto the exact one — reliably empty — and would still
route the request down the search path this exists to avoid.

**No fallback to text search when the ISBN matches no book.** An ISBN identifies
one edition or none, and the search it would fall back to is the search that
returns nothing slowly.

**An explicit `isbn=` wins if both are sent.** A caller using the parameter
deliberately should not have it silently overwritten by something inferred from
free text.

**The ISBN-10 checksum is enforced; the ISBN-13 one is not.** Thirteen digits
are an ISBN and nothing else, so a bad check digit there is a typo, and an empty
result is the honest answer — this also keeps `q` in step with `?isbn=`, which
has never checksummed. Ten bare digits are far more ambiguous (a year, an order
number, part of a phone number), so the checksum is what earns them the right to
be treated as an ISBN at all; roughly nine in ten random 10-digit strings fail it.

**Partial ISBNs stay searches.** A prefix of an ISBN identifies no book, so
turning it into an exact match would only convert a slow empty answer into a
fast one while removing any chance the text search finds something.

## Out of scope

- The typeahead endpoint, `GET /books/search?q=`. It has the same problem and
  the same fix available, but it is a different ranking contract and is left for
  a separate change.
- ISBN-10 storage. Nothing persists an ISBN-10; the conversion happens per
  request and is not written anywhere.
- SBNs (9 digits) and other pre-ISBN identifiers.

## How it was verified

`src/__tests__/isbn-query.test.ts` covers both halves: the recogniser's boundary
(printed forms, ISBN-10 conversion, `X` check digits, partials, embedded ISBNs,
failing checksums) and the endpoint's wiring (`q` cleared and `isbn` set, other
filters preserved, ordinary searches untouched, explicit `isbn=` respected),
driving the real controller with the service mocked. 12 tests, all passing;
`tsc --noEmit` clean.
