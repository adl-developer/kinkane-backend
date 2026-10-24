# Blacklisted accounts are emailed why, with a one-tap appeal

**Date:** 2026-10-24

## What changed

When an account is blacklisted, from the customer screen or from **Blacklist User** on a report,
its owner now gets the "Your account has been blacklisted" email from the Email Template designs.
It tells them:
- they can't access the app
- their profile and community activity are no longer visible to other members
- they can't buy books

Its appeal button opens an email to contactus@kinkane.app with the subject "Appeal the decision:
Your account has been blacklisted".

## Why

The client shared the account notice design and asked for blacklisted accounts to be told. Two
changes from the design:
- **The last bullet.** The design promised the bookstore stays open. The client decided purchases
  are refused too, so that bullet now says so.
- **A typo.** "You will not be access the app" is corrected.

## Data / API shape

- **No migration.**
- **New email job:** `account-blacklisted` `{ to, name }`.
- **Customer blacklist response:** `{ id, blacklisted, changed, sessionsRevoked }`, unchanged.

## Non-obvious decisions

- **The email goes out after the blacklist is committed.** For a report, that's after the reports
  are closed too, so nobody is told about a blacklist that rolled back.
- **Never on a re-click:** blacklisting an account that's already blacklisted sends nothing.

## How it was verified

- **`blacklisted-account.integration.test.ts`:**
  - a live session is revoked, sign-in answers `ACCOUNT_SUSPENDED`, and the old refresh token no
    longer works
  - community routes refuse the remaining token
  - exactly one email goes out, and none on a second blacklist
- **`moderation-emails.test.ts`:** checks the bullets, that the bookstore isn't promised, and the
  appeal subject.
