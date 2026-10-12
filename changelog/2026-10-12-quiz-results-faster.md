# Quiz results come back faster

## What changed

When quiz answers aren't already cached, the reader waits on three steps: an embedding, a vector search, and Gemini writing one short reason per recommended book. The reasons were the slow part, at 13–18 seconds of a 15–20 second wait. They now take about 4–6 seconds, and never more than 8.

No API shape changed. The guest quiz (`POST /recommendations`) and the signed-in retake (`PATCH /recommendations/refresh?includeRecommendations=true`) return the same response as before, just sooner.

## Why it was slow

We timed each step against the local catalogue and real Gemini:

| Step | Before |
|---|---|
| Liked books, author and genre lookups | ~10 ms |
| Preference embedding | ~0.8 s |
| Vector search | 2–6 s |
| **Explanations** | **13–18 s** |

The explanation step had four problems:

1. **Gemini skipped books without saying so.** Asked for 25 explanations, flash-lite returned 5–18 and reported that it had finished normally. More than half of each list went missing on the first pass.
2. **Retries were slow and lost books too.** Each retry round sent all the missing books in one large call, and the model dropped most of them again. The code also waited 2 s, then 4 s, between rounds. After every round had run, about 12 of 50 books still had an empty explanation.
3. **A single Gemini call had no time limit.** The 20-second retry budget was only checked between rounds, so a call already in progress could run on indefinitely. One test run sat in retries for 135 seconds.
4. **Large chunks are slow.** Gemini writes its answer one token at a time, so a 25-book call took about 5 s where a 10-book call takes about 2.5 s.

## How it works now

- **The number of answers is fixed.** Each call sends a response schema that requires exactly one entry per book in the chunk (`minItems` = `maxItems`). With it, the model returned every book on the first pass in all test runs.
- **Chunks of 10, up to 5 at once.** A 50-book list goes out as five parallel calls. The concurrency limit is shared across all requests, so many simultaneous cache misses still can't flood the API.
- **Retries are chunked, parallel and immediate.** Only books that came back blank or in the third person are asked again, split into 10-book chunks like the first pass. There is no sleep between rounds, because a bad answer is not a sign of load; real API errors still back off inside `withRetry`. There are at most 2 rounds, down from 3.
- **A hard 8-second limit on the whole step.** It covers the first pass and every retry, enforced with an `AbortSignal`. Each call also has a 5-second timeout, so one hung call can be retried instead of using up the whole limit. Once the 8 seconds are up, calls still in flight are aborted. No further `withRetry` attempt, fallback-model call or retry round starts, and any book still without an explanation gets an empty one. The app already handles an empty explanation, because a failed Gemini call produced one before this change too.

## Results

Ten timed runs of the explanation step on 50 real candidates:

- Nine finished in **3.9–6.3 s** with all 50 explained.
- One hit the 8-second limit because a single Gemini call was slow, and 10 books came back without an explanation. That is the trade-off the limit makes: a few empty explanations in place of a quiz that can hang for minutes.

## Left out of scope

- **Vector search, 2–6 s.** It is now the largest remaining cost and has not been profiled yet.
- **Returning the list before the explanations.** Sending the books first and filling in their reasons afterwards would bring the quiz down to about 3–4 s, but it needs changes in the app.
- **The second-person check.** `isSecondPerson` requires the word "you", so a line that opens by addressing the reader by name but never says "you" (*"{{name}}, this classic offers…"*) is still re-requested. Whether that kind of line is acceptable is a decision about the copy voice, so it was left as it is.

## How it was verified

- New unit tests in `src/__tests__/gemini-explanations.test.ts`, with the Gemini SDK stubbed. They cover:
  - the 10-book chunking;
  - the exact-count schema;
  - that every call carries the timeout and the shared signal;
  - that only bad books are retried, in chunks, with no sleep;
  - that the step returns as soon as the time limit passes, without starting another retry, fallback or round.
- The full unit suite passes.
- Timed against real Gemini on the local catalogue, before and after the change, using a throwaway script that is not committed.
