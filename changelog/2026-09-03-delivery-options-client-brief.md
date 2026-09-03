# A brief the client team can hand to their assistant

**Date:** 2026-09-03

## What changed

Adds `docs/delivery-options-client-brief.md`: a self-contained integration guide
for the delivery-options flow, written so it can be pasted into a client-side AI
assistant's context without needing anything else from this repo.

It covers why the chooser exists (the £8.45 against £32.52 Ghana gap), the
three-call flow, both endpoints in full with request and response shapes, the
minor-units rule, every error worth branching on, test destinations, and a
build checklist.

## Also fixes: the options endpoint lied while the flag was off

Found while writing the "what you will see today" section, which meant actually
running the endpoint with `SHIPPING_USE_RATE_TABLE=false`.

With the flag off, `quoteShipping` falls back to the flat per-country table,
which does not vary by service. The endpoint was still listing every service a
destination supports, so Ghana came back as two options at an identical £24.99 —
telling the buyer the tracked upgrade was free, and giving anyone integrating
today a shape that would change under them.

It now returns exactly one option when the rate table is off: the service the
order would actually ship by, at the flat price. The response shape is identical
in both phases, so a client that renders whatever the array contains works
before and after the flag flips with no release in between.

## Verified

Three new tests: one option at the flat price with `recommended` set, the right
service per destination (`011` overseas, `001` at home), and an empty array when
the flat table cannot price the destination at all.
