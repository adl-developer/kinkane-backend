# Blacklisted accounts can no longer sign in or buy, and every appeal button opens a ready-made email

**Date:** 2026-10-24

## What changed

This revises the blacklist behaviour from earlier the same day (see
`2026-10-24-blacklist-community-ban-moderation-emails.md`), after the "Your account has been
blacklisted" email design was updated.

**A blacklisted account is now locked out completely.**
- **Sign-in:** every method refuses it: password, Google/Apple and session refresh. All of these
  answer `403 ACCOUNT_SUSPENDED`. Their live sessions are ended on the spot.
- **Buying:** they can't buy, either signed in or **as a guest using the same email address**.
- **Their profile and community activity stay hidden from everyone else**, as before.
- **The access token they already hold:** it lives a few minutes longer, and community routes still
  answer it `403 ACCOUNT_RESTRICTED`.

**The account email follows the updated design.**
- Its list now says: they can't access the app, their profile and activity are hidden, and they
  can't buy books.
- The design's last bullet promised the bookstore. The client decided purchases are refused too, so
  that line now says so.
- The design's typo "You will not be access the app" is corrected.

**The appeal button, in all three moderation emails,** now reads **"Email to
contactus@kinkane.app"**. It opens a new email with the subject **"Appeal the decision: <subject of
the notice>"**, for example "Appeal the decision: Your review has been removed". The address is
still written underneath for email apps that won't follow the link.

## Why

The client updated the account notice design and asked for:
- sign-in blocked everywhere
- no purchases at all
- the new appeal button on every notice

## Data / API shape

- **No migration.**
- **`ACCOUNT_SUSPENDED` is back:** on login, refresh, social sign-in and checkout.
- **`sessionsRevoked` is back:** on the customer blacklist response.
- **Guest checkout:** refused when the contact email matches a blacklisted account. The match is
  the address as typed, case aside.

## Non-obvious decisions

- **The community guard stays.** Revoking sessions stops refreshes, but the access token in hand
  stays valid for up to 15 minutes. The guard covers that window, just as checkout's own check does.
- **The appeal button isn't uppercased like the other buttons.** Uppercase would shout the email
  address.
- **The guest-checkout match is case-insensitive only, not alias-aware.** For example, Gmail dots
  and `+tags` aren't treated as the same address. Someone determined to use a different address can,
  as with any email-based block.

## Out of scope

- **The Community Guidelines link:** still unlinked, because there's no page yet.

## How it was verified

- **`blacklisted-account.integration.test.ts`:**
  - an existing session is revoked
  - sign-in answers `ACCOUNT_SUSPENDED`
  - the old refresh token no longer works
  - community routes refuse the remaining access token
  - one email goes out
  - their activity is hidden from others and returns when the blacklist is lifted
- **The source-level blacklist test** again asserts the guard on every sign-in path, on checkout
  including the guest path, and on session revocation.
- **Not covered by an end-to-end test:** the guest checkout refusal itself. Only its presence in
  the source is checked.
- **Emails:** re-rendered with sending stubbed out. All three mailto links carry the right subject.
- **Full suites:** unit, integration and endpoint suites pass.
