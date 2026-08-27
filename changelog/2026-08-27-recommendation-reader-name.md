# Recommendations now address the reader by name

**Date:** 2026-08-27

## What changed

Recommendation explanations now speak to the reader directly:

> Elisabeth, you wanted something meaningful, but not heavy. This moves
> gently, but still challenges you.

The app always speaks **to** the reader, never **about** them: the name is a
form of address, not the subject of a sentence. "Elisabeth, you wanted
something meaningful" is right; "Elisabeth will love this", "Perfect for
Elisabeth, who enjoys slow-burn romance" and "Readers like Elisabeth tend to
enjoy this" are all wrong. The prompt carries both the good and the bad
patterns explicitly, and an explanation that comes back with no second-person
pronoun in it is treated as a failed generation and sent through the retry
rounds that already exist for chunks the model drops. If it still reads as
third person after those rounds it is kept and logged rather than discarded —
accurate copy in the wrong voice still beats a blank card, and a rising count
in that log is the signal that the prompt has lost its grip.

The name is the reader's **first name only** — "Elisabeth Mensah" is addressed
as "Elisabeth", because the full name in a sentence reads like a form letter.
Every explanation in the list is personalized, and the model is told to vary
where the name sits so a hundred cards don't all open the same way.

## The caching problem this had to solve

A recommendation result set is **shared between readers**. `hashInput` keys the
cache on preferences alone and deliberately excludes `displayName`, so two
people with identical quiz answers hit the same cached entry — that's the whole
reason a second identical quiz is instant instead of a fresh embedding plus a
hundred Gemini explanations.

Writing "Elisabeth," into that cached text would therefore serve Elisabeth's
name to the next reader with the same answers.

So the name never enters the cache. Gemini is instructed to write a literal
`{{name}}` token (`NAME_PLACEHOLDER` in `src/lib/gemini.ts`), the token is what
gets stored, and the real name is substituted on every read path —
`personalizeExplanations` runs on all six return points: the guest Redis hit,
the guest DB hit, a fresh guest generation, and the same three for a signed-in
reader. Cache hit rate is unchanged and no extra Gemini calls are made.

A side benefit: the reader's name is never sent to Gemini at all. It isn't in
the preference text, so it isn't in the embedding or the request payload.

## Non-obvious decisions

**The name is never in the prompt input, only the output shape.** The model is
told to emit the token verbatim and explicitly told not to invent or substitute
a real name.

**No re-truncation after substitution.** The 250-character cap is enforced on
the stored text, with the prompt told to budget roughly ten characters for the
name. Slicing again after substitution would cut a finished sentence mid-word,
which is worse than a card running a few characters long.

**A missing name degrades to an impersonal sentence, never a visible token.**
A literal `{{name}}` on a card is the one failure mode worth engineering
against, so with no usable name the token is stripped along with the
punctuation that attached it, and the sentence is re-capitalised: "You wanted
something meaningful." The signed-in path passes `null` rather than its old
`'User'` fallback, so a nameless account is not greeted as "User".

**First names are capped at 40 characters.** `displayName` accepts up to 100,
and all of them would land inside a 250-character explanation.

**The cache hash carries a prompt version.** Explanations written by an older
prompt would otherwise keep being served for the rest of their 48-hour TTL —
first name-free, and later in the wrong voice. `EXPLANATION_PROMPT_VERSION` is
part of the hash, so those entries retire on deploy and regenerate. It is at v3:
v2 introduced the name token, v3 required second person. Expect a burst of
regeneration on release, and bump it whenever a prompt change alters *what gets
cached*, not merely its wording.

## Not in scope

The recommendation email composes its own copy and is untouched.

## Verification

`npx tsc --noEmit` clean. New `src/__tests__/recommendation-personalization.test.ts`
(25 tests) covers first-name extraction, substitution at any position in the
sentence, the two-readers-one-cached-entry case that motivated the design, the
no-name strip, non-mutation of the cached array, pass-through of both
token-free and empty explanations, token-safe truncation, and the
second-person guard including near-misses like "youth" and "young". Full suite: 413 passing; the 3 failures in
`subscription-pricing.test.ts` pre-date this work and are unrelated (Stripe not
configured locally).
