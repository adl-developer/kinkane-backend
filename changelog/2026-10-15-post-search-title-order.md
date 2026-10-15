# Post search keeps its old order for book-title matches

Follow-up to `2026-10-15-community-search-post-text.md`, from code review.

## What was wrong

Post-text search added "how closely the post text matches" as the second sort
key for **every** result, ahead of "how closely the book title matches". Results
are first grouped by tier (title prefix, title word, exact wording, words,
fuzzy title), so this only reordered posts inside a tier. But it did reorder the
title tiers: of two posts whose book titles both start with the query, the one
whose text happened to mention the word jumped ahead of the closer title. That
broke the order post search used to have and still shares with group and
people search.

## What changed

The tie-break inside a tier now follows the reason for the match:

- **Exact-wording and word tiers:** how closely the post text matches
  (`ts_rank_cd`).
- **Title tiers:** title closeness (`word_similarity`), as before.

After that come book relevance, then newest first, then id. Title matches now
come back in the same order as before post-text search.

## Verification

A new integration case has two posts on books titled "Zib Tales" and
"Zibbleworth Grange". Only the second post's text says "zib". A search for
`zib` keeps "Zib Tales" first. That case fails against the previous commit.
