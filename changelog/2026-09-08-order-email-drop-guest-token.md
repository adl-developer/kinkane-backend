# Take the guest's long access token out of the order confirmation email

**Date:** 2026-09-08

## What changed

The order confirmation email no longer prints the guest access token. The
section headed *"You checked out as a guest. This longer code is what attaches
the order to an account if you make one later"*, and the 40-character code
under it, are gone from both the HTML and the plain-text part.

What a reader gets now:

| | HTML and text |
| --- | --- |
| Every buyer | The short tracking code, plus the reminder that the email address they ordered with is the other half |
| Signed-in buyer | The existing "see this order any time under **My Account**" line |
| Guest | Nothing after the tracking code |

The "My Account" line was deliberately not reused as the guest's replacement.
A guest does not have an account, so that sentence would be false for exactly
the person it was filling a gap for.

## Why

Two long codes, one right under the other, made the email hard to read and
made the short code — the one a customer actually needs — look like the less
important of the pair. The token is also a bearer credential, and an inbox is
a place mail sits forever, gets forwarded, and gets synced to devices nobody
is thinking about. Not printing it removes that exposure entirely.

## What this costs a guest, on purpose

Tracking is unaffected. `POST /orders/lookup` takes the tracking code plus the
contact email, both of which the email still carries (the email address being
the half that makes an eight-character code useless to guess).

**Claiming is not.** `POST /orders/claim` takes `reference` + `accessToken`,
and the checkout response is now the only place that token is ever shown — it
is generated at checkout, only its hash is stored, and it is handed to the
client exactly once. A guest who does not persist it at checkout has no route
to attach that order to an account later. That is accepted: it is the price of
checking out as a guest, and it is the client's job to keep the token from the
checkout response if it wants to offer claiming.

## Left alone

- `accessToken` stays on `OrderConfirmedPayload`. It no longer reaches the
  page; all it does now is tell a guest from a signed-in buyer, so the
  "My Account" line is only promised to someone who has one. Its doc comment
  used to explain why the token was printed and now says the opposite.
- The Redis handoff in `lib/guest-token-handoff.ts` still stashes the raw
  token at checkout and consumes it in the paid webhook. It is doing less work
  than before — the value is read and thrown away rather than rendered — but
  removing it is a separate change, and it is what supplies the guest/
  signed-in distinction above.
- No API, schema, or checkout change. This is the email only.

## Verified

`npx tsc --noEmit` clean; the order-confirmed email suite passes (12 tests).
The two tests that asserted the token was printed for a guest were replaced by
one asserting it appears in neither the HTML nor the text, and one asserting a
guest still gets the short code and is not shown the "My Account" line.
