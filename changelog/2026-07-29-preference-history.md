# Preference history: a permanent record of how a reader's taste changes

## What changed

`user_preferences` holds exactly one row per user and is updated in place, so
every time someone edited their preferences the previous state was destroyed.
We had no way to answer "what did this reader like six months ago?" or "how
often do people actually change their preferences?".

A new append-only table, `user_preference_history`, records a snapshot every
time a user's preferences change. A new endpoint,
`GET /api/v1/user/preference-history`, returns a user's own timeline.

Nothing about how preferences are read or written changes. `user_preferences`
remains the authoritative current state and no existing read path was touched,
so this cannot affect recommendations or anything else already working.

## Data shape

One row per change, each a **full snapshot** rather than a diff:

| Column | Notes |
| --- | --- |
| `user_id` | cascades on user delete |
| `feelings`, `book_ids`, `genres`, `dislikes` | the snapshot, mirroring `user_preferences` |
| `reader_type` | carried forward from `users.reader_type` |
| `changed_fields` | which fields differed from the previous row, e.g. `['genres']` |
| `source` | `onboarding` \| `user_edit` \| `system` |
| `recorded_at` | indexed with `user_id` |

## Decisions worth knowing about

**Snapshots, not diffs.** A diff-only log would mean replaying from the
beginning to reconstruct any past state — slow, and permanently fragile to a
single bad row. With snapshots, "what did this user like in March?" is one
indexed read. `changed_fields` gives the diff view on top, so we lose nothing.
These blobs are a few hundred bytes; the storage cost is not worth optimising.

**The preference embedding is not stored.** It is 768 floats, roughly 3KB, and
would have multiplied this table's size by about 10x. It can always be
regenerated from the snapshot, and there is no plausible query that wants a
historical embedding.

**Reader type shares this table rather than getting its own.** It is written on
a different code path than the other fields, so recording it separately would
have been the more literal design. But keeping it here means every row is a
self-contained picture of the taste profile, at the cost of one extra
`SELECT reader_type FROM users` when recording an edit. Worth it.

Note that reader type currently has no user-facing edit path at all — it is
inferred once from the onboarding book picks and never changed again. So this
column captures one event per user today. It is wired up and ready for the day
a re-assessment or settings toggle exists, but nobody should expect a rich
reader-type timeline yet.

**Application-level writes, not a database trigger.** A trigger would catch
every write automatically, including future ones we forget about. But it cannot
see *why* a change happened, which would have made `source` dead weight, and it
hides logic outside the Drizzle schema where nobody looks. There are exactly
two write paths and both are in service code.

**A history failure never fails a user's save.** On the edit path the history
write is wrapped in try/catch and logged. The user's preference save has already
succeeded by that point, and losing one audit row is a much better outcome than
telling someone their save failed. On the onboarding path it runs inside the
existing migration transaction and rolls back with it.

**No-op saves are not recorded.** Change detection is order-insensitive, so
re-saving the same genres in a different order does not append a row. Without
that, the timeline would fill with duplicates every time a client re-submitted
an unchanged form.

## Retention

Rows older than two years are pruned by a new daily cron at 03:20, following the
same shape as the existing guest-session cleanup.

The prune deliberately **never deletes a user's most recent row**, regardless of
age. A user who set their preferences once at signup and never touched them
again would otherwise have their entire history deleted on the two-year
anniversary, leaving an empty timeline for someone who still has live
preferences. That exemption is the reason the delete needs a window function
rather than a plain `WHERE recorded_at < cutoff`.

## Backfill

The migration seeds one baseline row per existing user from their current
preferences, dated `user_preferences.updated_at` rather than now, so the
baseline reflects when they actually last set their preferences. Real history
starts from this release — changes made before it were overwritten in place and
are unrecoverable.

## Out of scope

- **Notification preferences.** Explicitly excluded; `notification_preferences`
  keeps no history. It would be the same pattern in a separate table if wanted
  later.
- **Restoring a past state.** The data supports it, but there is no endpoint to
  roll a user back to an earlier snapshot.
- **Admin or analytics access.** The endpoint is self-only; there is no
  cross-user query path.

## Verification

- `tsc --noEmit` passes.
- 10 unit tests cover change detection — reordered arrays and object keys are
  correctly treated as unchanged; additions, removals, nested `dislikes`
  changes, and reader-type changes are correctly detected; `null` is
  distinguished from `[]` and numbers from their string forms.
- The migration SQL and the prune SQL have **not** been executed. There is no
  local Postgres or Docker on this machine, and the configured `DATABASE_URL`
  points at a remote host, so both are reviewed but unrun. Apply the migration
  against a non-production database first and confirm the backfill row count
  matches the `user_preferences` row count.
