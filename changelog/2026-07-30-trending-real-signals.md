# Trending is now driven by what readers actually do

**Date:** 2026-07-30

## What changed

The "Trending" shelf now reflects real reader behaviour. Opening a book page,
liking a book, and moving it through *Want to read → Reading → Read* are all
recorded as signals, and the trending list is scored from them — weighted by how
meaningful each action is and faded out as it gets older.

Nothing about the API changed. `GET /api/v1/explore/trending?limit=10` returns
the same shape as before; only the contents and their ordering are different.

## Why

Trending was already querying an interactions table, but almost nothing was
writing to it. The only code that ever inserted a row was the guest-to-user
migration, which seeds the five books picked during onboarding. Two of the three
signal types the query looked for — `view` and `wishlist` — were never written by
anything, and `wishlist` isn't even a concept in the app.

The practical effect was that "Trending" was really *"onboarding picks, then the
most recently published books"*, because whenever the interaction data ran out
the query topped the list up from `publication_date DESC`. On a catalogue this
size that fallback did most of the work.

## What counts, and for how much

| Action | Weight |
|---|---|
| View a book page | 0.25 |
| Like | 2 |
| Want to read | 3 |
| Reading | 4 |
| Read | 5 |
| Chosen during onboarding | 1 (unchanged) |

The weights are not ordered purely by "how much the reader liked the book" —
they're ordered by intent *relative to how often the action happens*. Views are
one to two orders of magnitude more common than completed reads, so scoring a
view anywhere near a read would quietly turn trending back into a pageview
counter. Hence 0.25: present, but easily outweighed.

Going down the funnel each step is rarer and more committed, so each is worth
more. The useful consequence is that **want-to-read tends to drive the list in
practice** — it's frequent, and it's how buzz shows up first — while a completed
read still counts properly on the rarer occasions it happens. Volume does the
balancing, so there was no need to choose between the two:

> A buzzy new release with 50 *want to read*s scores 150. An older title with 10
> completed reads scores 50. The buzzy one wins, despite `read` having the higher
> per-event weight.

Progressing through all three reading statuses deliberately records all three
signals. Sustained engagement with a book genuinely is a stronger signal than a
single status change.

`purchase` and `high_rating` have weights defined but are not scored, because
nothing writes them yet. Enabling either is a one-line change.

## Time decay

Scores now fade with a **7-day half-life**. Previously a book that spiked on day
one sat in the list at undiminished strength for the full 30-day window, which
made "trending" closer to "was trending at some point this month". A signal is
now worth half as much a week later and about 5% as much at the window's edge.

Concretely, a view from today outranks a completed read from six weeks ago.

## Anti-gaming

This is the part that needed the most care — the list is public, so anything that
lets one person move it is a problem.

- **Views:** at most one per (user, book) per **7 days**, enforced with a Redis
  `SET NX EX` guard. A 24-hour window was rejected: it would still let one
  determined user contribute 30 × 0.25 = 7.5 points over the trending window,
  more than a completed read, which is obviously wrong. Seven days caps a single
  user's view contribution to one book at roughly 1 point.
- **Everything else:** at most one row per (user, book, type), **permanently**,
  enforced by a partial unique index in Postgres rather than a Redis key that
  would have to live forever. Like → unlike → like is worth exactly one row.

Views are excluded from that index precisely because they're meant to recur.

**Unliking does not retract the signal.** The interaction log is append-only: the
reader's attention on that book at that moment was real, and it ages out of the
window on its own. Retracting would also make like/unlike a lever for hand-tuning
a public list — and re-liking can't re-add the row anyway.

## Data model

No new tables. `user_interactions` gains:

- `idx_user_interactions_unique_non_view` — partial unique index on
  `(user_id, book_id, type) WHERE type <> 'view'`.
- `idx_user_interactions_trending` — **replaced**. Was `(created_at, book_id)`,
  now `(created_at, type, book_id)`, because the scoring query filters on `type`
  as well. `created_at` still leads as the range predicate.

The migration deletes pre-existing duplicate non-view rows before creating the
unique index, keeping the earliest row of each group (and therefore its original
timestamp). Without that step the index cannot be created on any database that
already has duplicates — and the onboarding seed could produce them whenever a
guest's chosen-book list repeated an ID. That insert now uses
`ON CONFLICT DO NOTHING` so it can't abort the signup transaction.

## Retention

View logging makes this the fastest-growing table in the database. A new daily
cron at 03:40 prunes rows older than **180 days** — well past the 30-day read
window, but enough history to retune the weights or feed future recommendation
work. It's scheduled 20 minutes after the preference-history cleanup so the two
large `DELETE`s don't contend.

## Non-obvious decisions

**Weights are applied at query time, not stored on the row.** The `weight` column
is still written (defaulting to 1.0) and still multiplies into the score as a
per-row modifier, but the *type* weight comes from a constant in
`interactions.service.ts` and is applied by a `CASE` in the query. These numbers
will be retuned once there's real traffic, and baking them into rows at insert
time would make every retune a backfill.

**Recording never blocks or breaks the action that triggered it.** All writes are
fire-and-forget with errors logged and swallowed. A Redis blip while recording a
view must not turn a working book page into a 500, and `GET /books/:id` is the
hottest read in the app — analytics does not belong in front of its response.

**The trending cache key moved to `trending:v2:`.** Otherwise v1 payloads with the
old flat ranking would keep serving for up to an hour after deploy.

## Out of scope

**Anonymous views are not recorded.** `GET /books/:id` is public and most traffic
is probably signed-out, but `user_interactions.user_id` is `NOT NULL` with an FK
to `users`, so attributing anonymous views needs a nullable column and a
session-based dedupe key. Deferred deliberately — the signal from signed-in
readers is higher quality, and `guest_sessions` already exists if this turns out
too thin.

**The feedback loop is accepted, not solved.** Books on the trending shelf get
more views, which raises their score. The low view weight and the per-user cap
keep it in check and deliberate actions dominate the ranking, so this is worth
revisiting with real traffic rather than engineering around it now.

## How it was verified

Unit tests in [interactions.test.ts](../src/__tests__/interactions.test.ts) (18
tests) pin the weight ordering, the ranking properties described above, the decay
curve at each half-life, and the dedupe guard selection. Full suite: 49 passing,
`tsc --noEmit` clean.

The migration and the scoring query were executed against a throwaway PostgreSQL
16 instance, confirming that: the dedupe step keeps the earliest row; the unique
index rejects a duplicate non-view while still allowing repeated views; and the
planner uses `idx_user_interactions_trending`. The ranking fixtures came out as
intended:

| Book | Signals | Score |
|---|---|---|
| 1 | 50 want-to-read, 1 day old | 135.86 |
| 3 | 200 views, 1 day old | 45.29 |
| 2 | 10 reads, 1 day old | 45.29 |
| 4 | 50 want-to-read, 28 days old | 9.37 |
| 5 | 40 purchases (unscored) | excluded |

Books 2 and 3 landing level is the weighting working as designed: 200 distinct
viewers is worth about the same as 10 people finishing the book. Book 4 shows the
decay — identical to book 1, but four weeks stale.
