# Stop reader-type inference from defaulting to "The Seeker" on ambiguous picks

**Date:** 2026-07-24

## What changed

`inferReaderType` in [gemini.ts](../src/lib/gemini.ts) classifies a user into
one of 8 reader types from the titles/authors/genres of the 5 books they
picked during onboarding. Testing across a range of real and synthetic book
selections showed "The Seeker" (primarily non-fiction) acting as a de facto
default for any mixed or ambiguous set — e.g. a deliberate spread across 5
different fiction subgenres (fantasy/romance/crime/literary/sci-fi) landed on
either Seeker or an unrelated type rather than "The Open Door", and an
eclectic mix of literary prize-winners landed on "The Echo Collector" rather
than "The Book-ist". Two of the 8 types were never being produced at all.

Root cause: "The Open Door" and "The Book-ist" are defined by reading
*behaviour* (TBR pile size, abandon rate, reading multiple books at once,
following prize lists) that never reaches the model — it only ever sees 5
titles/authors/genres. The old descriptions described that behaviour
directly, giving the model nothing concrete in the actual input to match
against, so it fell back to whichever genre-based type fit best (usually
Seeker for anything nonfiction-adjacent).

Changes:

- Rewrote all 8 `READER_TYPE_DESCRIPTIONS` to anchor on signals the model can
  actually observe (genre spread, specific titles, topic pairing) instead of
  unobservable reading habits.
- Added explicit guidance in the prompt: don't default to Seeker for a mixed
  or hard-to-classify set — only choose it when non-fiction clearly
  dominates, and prefer "The Open Door" or "The Book-ist" for a
  genre-spanning selection instead.
- The model now returns a `reasoning` field alongside `readerType` (still
  strict JSON) citing the specific signal behind its choice. Not persisted
  anywhere yet, but logged on an unrecognised-type response for debugging.

## Non-obvious decisions

- **Kept `responseMimeType: 'application/json'` and `temperature: 0`** —
  the `reasoning` field is requested *before* `readerType` in the JSON
  schema so the model still gets a brief "think before answering" step
  without giving up strict structured output.
- **Didn't touch the retrieval-side format filter** (same date, see
  [2026-07-24-fiction-format-filter.md](2026-07-24-fiction-format-filter.md))
  even though both changes target the same "Seeker over-triggers" symptom —
  they fix different layers (which books get shown vs. how the 5 chosen ones
  get classified) and are independently useful.

## Verification

Ran the same book selections through old vs. new prompt side by side against
the live model:

| Case | Old | New |
|---|---|---|
| Pure non-fiction | Seeker | Seeker (unchanged) |
| Pure romance | Cloud Illusionist | Cloud Illusionist (unchanged) |
| 5 different fiction subgenres | Mirror Within | **The Open Door** |
| Literary prize-winners across genres | Echo Collector | **The Book-ist** |
| Bestseller/thriller set | Story Circler | Story Circler (unchanged) |
| Niche sci-fi + hard science | High Summiter | High Summiter (unchanged) |
| *A Little Life*, *The Kite Runner*, etc. | Mirror Within | Mirror Within (unchanged) |

Every previously-correct case stayed correct; all three previously-unreachable
cases now classify correctly instead of collapsing into Seeker/Mirror
Within/Echo Collector. Re-ran the same cases against the actual updated
`inferReaderType` (not just the comparison script) to confirm the shipped
code matches. `tsc --noEmit` and the existing test suite pass unchanged.
