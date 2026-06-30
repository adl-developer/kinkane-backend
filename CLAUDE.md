# Project instructions for Claude

## Changelog entries on every commit

This repo generates `CHANGELOG.md` from commit history via `conventional-changelog`
(see `npm run changelog` and `.githooks/pre-commit`). That tool only repeats back
whatever is in the commit message — it has no idea what the change actually does
or why it matters. That context has to come from the commit message itself.

So: whenever you create a commit in this repository, write the commit message
so that it reads well as a standalone changelog entry — something a non-technical
stakeholder skimming `CHANGELOG.md` could understand without opening the diff.
Concretely:

- **Subject line**: Conventional Commits format (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `perf:`, `test:`), but the description after the colon should be
  written in plain, human language — describe the user-facing or operational
  effect, not the implementation. Prefer "fix: stop refresh from hanging when
  Gemini is slow" over "fix: make embedding regen async in refresh()".
- **Body**: 1-3 sentences of *why* this change exists and what it changes about
  the app's behavior — not a restatement of the diff. Skip the body only for
  changes too small to need one (a typo fix, a dependency bump with no
  behavior change).
- **No jargon dumps**: avoid pasting function/variable names, file paths, or
  internal terminology into the subject line. Those belong in the body if at
  all, and only when they help someone understand the change, not as a
  shorthand for it.
- **One logical change per commit**: this repo already splits unrelated work
  into separate commits (see git log for examples) — keep doing that. A
  changelog entry that bundles three unrelated fixes under one message is not
  human-readable no matter how it's worded.

When in doubt, write the message as if it's the only thing the reader will
ever see about this change — because in `CHANGELOG.md`, it is.
