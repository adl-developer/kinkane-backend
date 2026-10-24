# A blacklisted owner's groups pass to Kinkané Admin

**Date:** 2026-10-24

## What changed

When the owner of a group is blacklisted, their groups now pass to a house account, **Kinkané
Admin** (contactus@kinkane.app):
- Kinkané Admin becomes the owner shown on the group page, and an active member.
- The former owner stays in the group as a hidden member, like the rest of their activity.
- contactus@kinkane.app is emailed the groups that were handed over, and who owned them.
- **Ownership stays with Kinkané Admin if the blacklist is lifted.** An admin can hand a group back
  by hand.

## Why

Before this, a blacklisted owner's group carried on with their name and photo still shown as the
owner, even though their profile was gone everywhere else. The client asked for the group to pass
to Kinkané Admin and for contactus@kinkane.app to be told.

## Data / API shape

- **No migration.**
- **The Kinkané Admin account** is created the first time it's needed, with no password.
- **New email job:** `groups-handed-over`
  `{ to, formerOwnerName, formerOwnerEmail, groups: [{ id, name }] }`.

## Non-obvious decisions

- **The handover is part of the blacklist itself, in one transaction.** A blacklist can't land
  without it.
- **Kinkané Admin is counted as a member like any other join.** Inviting or requesting it doesn't
  count; becoming an active member does, and the member count moves with it.
- **If someone has already signed up with contactus@kinkane.app, that account is used.** Since it's
  the company inbox, whoever holds that mailbox could also sign in to it, for example with Google or
  a password reset.
- **Never the house account handing to itself:** blacklisting Kinkané Admin hands nothing over.

## How it was verified

`blacklisted-account.integration.test.ts`:
- the group's owner becomes Kinkané Admin and its member count goes up by one
- the former owner keeps their membership row but isn't listed
- contactus@kinkane.app is emailed the group
- after the blacklist is lifted, Kinkané Admin is still the owner
