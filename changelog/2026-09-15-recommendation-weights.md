# Configurable recommendation weights

## What changed

**This ships dark.** `RECO_WEIGHTING_ENABLED` defaults to false, and while it is
off the search builds its vector exactly as before, cache keys are unchanged,
and the weights below are inert. Deploying changes nothing until someone turns
it on.

Worth knowing before you do: off is not the same as every weight at 100.
Combining four separately embedded fields produces a centroid, which points
somewhere slightly different from one embedding of the same words joined
together. Results will shift on the day it is enabled, before any tuning.


Each preference field the quiz collects — genres, liked books, feelings,
dislikes — now has its own weight between 0 and 100, set in the environment:

```
RECO_WEIGHT_GENRES=100
RECO_WEIGHT_BOOKS=100
RECO_WEIGHT_FEELINGS=100
RECO_WEIGHT_DISLIKES=40
RECO_WEIGHT_TAGS=0
```

Raising a weight makes that field pull harder on the search. Setting one to 0
removes it entirely. The four distance and pool settings the search runs
against are env-tunable too (`RECO_SIMILARITY_MAX`, `RECO_BACKFILL_MAX`,
`RECO_TARGET_RESULTS`, `RECO_FETCH_POOL`), because the weights and the cutoffs
have to be tuned together.

## Why

Before this, the four fields were joined into one paragraph and embedded as a
single vector. That gave each field a weight nobody chose: whatever share of
the paragraph its text happened to occupy.

Measured on a representative quiz answer — 3 feelings, 2 genres, 5 liked books,
3 dislike labels — the split was:

| field | characters | share |
|---|---:|---:|
| liked books | 236 | 62.9% |
| dislikes | 55 | 14.7% |
| genres | 44 | 11.7% |
| feelings | 37 | 9.9% |

Liked books dominated because titles and author names are long, not because
they matter most. A reader who named five books got a search that was
essentially "more like these five", with their stated feelings contributing
under a tenth of the signal. A reader who named none got a completely
different balance from the same quiz, with dislikes as the largest clause at
39.6%.

## How it works

Each field is embedded on its own, every vector is scaled to unit length, and
the results are combined:

```
v = normalize( Σ sign · (weight / 100) · normalize(v_field) )
```

Normalising first is what makes the weights mean anything — it strips out the
"book titles are long" effect, so a weight of 50 means the same thing to every
field. The combined vector is normalised again and used exactly as before, so
the database side of the search is unchanged: one pgvector query, same index,
same ordering.

The weights are relative, not shares of a budget. Every weight at 50 behaves
identically to every weight at 100, because cosine distance ignores magnitude.
Only the ratio between fields changes the result.

## Dislikes now work in the right direction

The dislikes lane is subtracted rather than added.

This fixes a real defect. Embeddings have no notion of negation, so the old
text `"I want to avoid: gore"` landed near *gore* in vector space — a stated
dislike was pulling results toward the thing being rejected. Roughly 15% of the
signal was spent making the problem worse. The lane now carries a plain
description of the subject and the minus sign expresses the avoidance, which is
what the vector space can actually represent.

## Non-obvious decisions

**An untouched environment keeps its warm cache.** The retrieval fingerprint is
omitted entirely — not set to a fingerprint of the defaults — when weighting is
off and the cutoffs are unchanged, so the cache key stays byte-identical to the
previous release's. Otherwise a deploy that changed no behaviour would still
have discarded 48 hours of cached recommendations and paid to regenerate them.

**The weights are part of the cache key.** Results cache for 48 hours against a
hash of the reader's answers, so a weight change would otherwise be invisible
until every existing entry expired — you would tune a value, see no change, and
conclude it did not work. A fingerprint of the weights and cutoffs joins the
hash, alongside the explanation prompt version that already served this role.

**Existing stored embeddings are left alone.** `user_preferences.preference_embedding`
is a persisted vector built the old way for every user who registered before
this. It is not migrated and there is no version column. This is safe because
nothing compares two readers' preference vectors to each other — both consumers
(the personalized feed and the recommendation email) compare a preference
vector to *book* vectors, and an old row is still a valid query against the
catalogue. The consequence is that weight changes reach the quiz immediately but
reach an existing reader's Home feed only once something rewrites their vector,
which registration and every preference edit already do. The table converges on
its own; no backfill job.

**Zero means gone, not negligible.** A field at weight 0 is dropped before the
embedding call, so turning one off makes the request cheaper rather than
counting it slightly.

**There is a fallback.** If every weight is 0, or the lanes cancel each other
out and leave no direction to search in, the old single-paragraph embedding is
used and a warning is logged. That is a misconfiguration, and a reader asking
for recommendations should still get recommendations while somebody fixes the
environment.

**`buildPreferenceText` is still here.** It is the right input for the
explanation model, which wants prose that reads like a person describing their
taste. Only the search vector changed.

**The pool ceiling tightened from 1000 to 500.** `RECO_FETCH_POOL` is bounded at
500 in the schema, not at the 1000 pgvector would accept. The pool is paid for
in latency under the iterative index scan — 300 rows return in ~800ms against
the live catalogue, 1000 in 5-18s — and an env var should not be able to
reintroduce that. Raising it is a code change, so it goes through review.

## Tags and reviews

`RECO_WEIGHT_TAGS` exists and defaults to 0. The lane is wired up and inert
until the quiz collects reader tags; enabling it then is an env change plus a
populated input, not a release.

Reviews are deliberately **not** covered. A review score is an attribute of a
book, not a description of a reader's taste, so there is nothing to embed as a
lane. Weighting reviews means blending a score after retrieval, which would
change `rank` from exact cosine order — the thing the HNSW `strict_order`
setting currently protects. That is a separate decision.

## Out of scope

No migration, no embedding-version column, no backfill job, no re-rank blend.

## Verification

`npx tsc --noEmit` is clean. The weighting maths is covered by 11 new tests in
`src/__tests__/preference-weights.test.ts`, which pin the properties the
feature is sold on: weight 0 drops a lane, weights behave as ratios rather than
shares, a heavier lane pulls the result towards it, a negative lane pushes away,
the output is always unit length, and the degenerate cases return null so the
caller falls back instead of searching on noise.

Four failures in the existing suite (`subscription-pricing`, `referral-copy`)
are date-dependent and pre-existing — they fail identically against the previous
config on this date.
