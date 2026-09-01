# Signup emails: the code first, the welcome message second

## What changed

At signup the verification code now goes out immediately and the welcome email
follows two minutes later. Until now it was the other way round — the welcome
email went first and the code waited.

The delay also applies to the welcome email on the Google sign-in path, which
previously sent it the moment the account was created.

## Why

Spacing the two emails was right; the order was backwards. The code is the one
thing a new reader is actually blocked on — they are sitting on the
verification screen with the app waiting — and making them wait two minutes for
it is two minutes of a stalled signup. Nothing depends on the welcome email
arriving promptly, so it is the one that can afford to wait.

## Non-obvious decisions

**The token's expiry went back to being measured from signup.** The previous
version pushed `expiresAt` out by the delay so the 15 minutes the copy promises
were counted from delivery rather than from signup. With the code sending
immediately there is no gap left to compensate for, so that adjustment came out
along with the `delayMs` parameter on `issueEmailVerification`.

**Google signups wait too, even though nothing is racing them.** Those accounts
arrive already verified and never receive a code, so there is no second email
for the welcome to stay clear of. It is delayed anyway so that both signup
routes feel the same from the inbox, rather than one delivering its welcome
message noticeably sooner than the other.

**Priority was already correct and was left alone.** `verify-email` sits at
priority 3 and `welcome` at 5, so the code was ahead of the welcome message in
the queue regardless. The delay makes the two-minute gap real rather than a
mere ordering preference under load.

## Out of scope

Resends are untouched: `resendVerificationEmail` has always sent immediately,
and still does.

## Verification

`tsc --noEmit` clean. The behaviour is a BullMQ `delay` on the enqueued job, so
it is visible in Bull Board at `/admin/queues` as a delayed `welcome` job with
the `verify-email` job already through.
