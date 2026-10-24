# The content-removed and group-blacklisted emails follow the designs, with a one-tap appeal

**Date:** 2026-10-24

## What changed

The two moderation emails now follow the Email Template designs:
- a sand "Community notice" band
- a cream panel with the details
- an appeal button

**Content removed**, sent to the author. It replaces the old "We've hidden your review" email:
- subject "Your [post / comment / review] has been removed"
- the type, the date it was submitted, and the reason

**Group blacklisted**, sent **to the owner only**. Members no longer get one; the group just
disappears for them. The subject is "Your group has been blacklisted".

**The appeal button** reads **"Email to contactus@kinkane.app"**. It opens a new email with the
subject **"Appeal the decision: <the notice's subject>"**, so each appeal arrives saying which
notice it answers. The address is also written underneath for email apps that won't follow the
link.

## Why

The client shared the designs and asked for:
- the owner-only group notice
- the "Email to contactus@kinkane.app" button with a ready-made subject

The Community Guidelines are named in the emails but not linked, because there's no page yet.

## Data / API shape

- **No migration.**
- **Email jobs:**
  - `content-hidden` is renamed `content-removed`, and takes `submittedAt` instead of the book
    title.
  - `group-blacklisted` loses `isOwner`.
- **Blacklist group response:** `emailed` is now 1, or 0 when there was nothing to do.

## Non-obvious decisions

- **The appeal button isn't uppercased** like the other buttons, because uppercase would shout the
  email address.
- **Shared notice pieces in the email layout:** an eyebrow band, a notice panel, detail rows,
  bullets and the appeal button. Every moderation email draws from these.

## How it was verified

- **New `moderation-emails.test.ts`:** checks subjects, titles, dates, appeal links with their
  decoded subjects, escaping of names and group names, and that the guidelines aren't linked.
- **`admin-moderation.integration.test.ts`:** the email is `content-removed`, and only the owner
  gets the group email.
- **Rendering:** both emails were rendered with sending stubbed out and compared with the designs.
