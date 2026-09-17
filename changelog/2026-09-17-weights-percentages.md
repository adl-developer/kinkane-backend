# The recommendation weights are percentages now

## What changed

`RECO_WEIGHT_BOOKS`, `_FEELINGS`, `_GENRES`, `_DISLIKES` and `_TAGS` are now
percentage shares of one search and must total exactly 100. The server refuses
to start otherwise, naming every value, the total it got, and how far off it is.

Before, they were relative: each lane's weight was divided by 100 and the
combined vector normalised at the end, so only the ratios between them mattered
and any five numbers were valid. `100/15/8/15/0` and `72/11/6/11/0` describe the
same search — the first is the second scaled up.

## Why

The weighting document describes each algorithm as a column of percentages
totalling 100. Under the old scheme those had to be collapsed and rescaled
before they could be written into an environment, which meant the numbers in
the file were never the numbers in the document, and checking that production
matched the intent required redoing that conversion by hand every time.

Pinning the total at 100 makes the environment and the document the same
artefact. That is the entire benefit, and it is a real one — but it is worth
being clear that it buys nothing mathematically. The combination still divides
through by the total, so a set summing to 110 would search perfectly well. The
constraint is on the file, not on the maths.

## What it costs

These were the arguments against, and they all still apply — they were accepted
knowingly rather than answered:

- **Every change is now a multi-value edit.** Raising mood means deciding which
  field gives up the share. Under relative weights you changed one number.
- **There is now a way to be wrong.** A set that does not total 100 stops the
  server. Previously no combination was invalid.
- **Enabling the tags lane later means taking share from the other four**, since
  the total is fixed. It cannot simply be switched on.
- **Small lanes lose resolution.** Explorer's dislikes share is 6% and cannot be
  expressed more finely without going fractional.

The exit is deliberate, and normalising silently would be worse: `40/30/20/20`
looks like it gives books 40% and would actually give it 36%, with nothing
anywhere saying so. The numbers on the screen have to be the numbers in use or
the change achieves the opposite of what it was for.

## The converted splits

Each totals 100. `.env.example` carries all three, and a test keeps them
totalling 100 so a future edit cannot quietly break one.

| | books | feelings | genres | dislikes | tags |
|---|---|---|---|---|---|
| Taste DNA | 72 | 11 | 6 | 11 | 0 |
| Mood First | 42 | 31 | 11 | 16 | 0 |
| Explorer | 64 | 23 | 7 | 6 | 0 |

Defaults moved from `100/100/100/40/0` to `29/29/29/13/0` — the same ratios
expressed as shares, so an environment that enables weighting without choosing a
split still gets three fields pulling equally and dislikes pulling less. They
had to change: defaults that do not total 100 would stop every boot.

## How it was verified

**The conversion doesn't shift results.** The new values are a rounding of the
old ratios, so the question is whether the rounding matters. Combining four
fixed lane vectors under the old weights and the new ones gives cosine
similarities of 0.999989 (Taste DNA), 0.999922 (Mood First) and 0.999956
(Explorer) — under 0.72° apart in 768 dimensions, far below the gap between
adjacent candidate books.

**The splits steer the results the way they claim.**
`scripts/reco-weight-effect-probe.ts` holds one reader fixed, changes only the
weights, and measures the top 50 against poles taken from real catalogue books
(a cosy Christmas novel for mood, a romance for the genre answer, a violent
novel for the dislike). As the books share falls 72 → 64 → 42, results move
steadily away from the reader's own books; as the mood share rises 11 → 23 →
31, they move steadily towards the mood pole. Taste DNA and Mood First share
only a handful of their top 50. The script exits non-zero if any of its five
claims fails. It uses book vectors in place of Gemini's embedding of the quiz
text, so it tests the weighting, not the wording of the mood lane.

**Unit tests.** `reco-config.test.ts` boots the config against each case: a
split totalling 100 starts and is used as written; over and under 100 refuse to
start with the total and the correction spelled out; an out-of-proportion split
is refused rather than rescaled; the dislikes and tags shares count; and the
defaults are themselves a valid split. Confirmed to fail with the check removed.
Full suite green (872 tests), typecheck clean.

**Not run end to end.** Partway through, the Gemini key started returning
`403 — Your project has been denied access`, having worked earlier. That is
unrelated to this change — it blocks every embedding call under any weighting —
but it means the three splits have not been through the real endpoint. Worth one
run of `scripts/reco-weight-probe.ts` for each once the key is sorted.
