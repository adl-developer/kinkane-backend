# A blacklisted customer can no longer buy as a guest under their own email

**Date:** 2026-10-24

## What changed

Checkout already refused a signed-in blacklisted account. It now also refuses a **guest checkout
whose email address belongs to a blacklisted account**, with the same `403 ACCOUNT_SUSPENDED`.

## Why

The client decided a blacklist means no purchases at all. Before this, a blacklisted customer could
sign out and buy as a guest using the same address.

## Non-obvious decisions

- **The address is matched as typed, ignoring letter case.** It isn't alias-aware: Gmail dots and
  `+tags` count as different addresses. Someone set on using a different address can, as with any
  block based on email.
- **The lookup uses the email index.** Account emails are stored lowercased, so the typed address
  is lowercased to match them. Lowercasing the column instead would scan every account on every
  checkout.

## How it was verified

- **`blacklisted-account.integration.test.ts`:** the address is refused in any letter case, other
  addresses go through, and it's allowed again once the blacklist is lifted.
- **`blacklist-enforcement.test.ts`:** checks that checkout calls the guard after settling the
  contact address.
