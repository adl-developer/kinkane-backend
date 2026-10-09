# Quiz picks go to Want to Read, not liked

## What changed

Books a reader picks in the quiz now go on their shelf as **Want to Read**
(`status: "want_to_read"`, `liked: false`). Before, they were saved as liked
with no reading status, so they showed up under Liked even though the reader
never tapped the heart.

This applies to both quiz paths:

- **The first quiz**, whose picks are saved to the shelf when the guest signs up
- **A quiz retake** by a signed-in reader (`POST /recommendations/selections`)

The heart button doesn't change: it still saves `liked: true` with no reading
status.

## Decisions

- **Existing readers are left as they are.** Picks saved before this change
  stay liked with no status. Only new quiz picks follow the new rule.
- **A book already on the shelf is never changed by a quiz.** It is filtered
  out of quiz results, and if a stale client sends it anyway, its status, like
  and note are kept.
- **Books on the shelf never come back in the quiz.** This was already true and
  hasn't changed: every shelf entry, whatever its status or like, is excluded
  from quiz results, and every shelf write clears the cached exclusion list.
- **The "readers like you" feed is unaffected.** It counts quiz picks by their
  source, not by the like flag, so turning the like off doesn't remove them
  from it.

## Verification

Both quiz paths build their shelf rows from one shared function, so the first
quiz and a retake can't drift apart. `quiz-picks.test.ts` checks its output for
both sources: Want to Read, not liked, no like timestamp. The retake test also
checks the rows the retake actually inserts. The signup path is covered through
the shared function, not by an end-to-end signup test. The full unit suite and
the TypeScript typecheck pass.
