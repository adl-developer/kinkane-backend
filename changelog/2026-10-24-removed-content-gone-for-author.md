# Removed posts, reviews and comments are gone for their author too

**Date:** 2026-10-24

## What changed

When a moderator hides a post, review or comment, it's now removed for **everyone, its author
included**. Before, the author still saw it, marked `isHidden`. Unhiding still brings it back as it
was.

## Why

The client confirmed that removed content should be gone for its author too. That also matches the
"Your [post / comment / review] has been removed" email design, which tells them the content is
"no longer visible on the platform".

## Data / API shape

- **No migration.**
- **`isHidden` is removed** from posts, comments and book-club comments. Hidden content never
  reaches anyone now, so the flag would always be false.
- **Hidden content answers 404 to its author** when they open it, edit it, delete it, like it or
  reply to it. It's also left out of their own post list and "my review" on book pages.

## Non-obvious decisions

- **Hiding still works by making a post private,** which already keeps it from everyone else. The
  author's own paths now also check `hidden_at`.
- **Switching visibility no longer needs special handling.** Before, an author could switch a
  hidden post to public and that choice was stored for later. They can't reach a hidden post now,
  so that code is gone.
- **Mentions in removed content** now show their excerpt to no one. They're held the same way as a
  private post's.

## How it was verified

`admin-moderation.integration.test.ts`:
- removed content is 404 to its author, by id, in their own list, and to edit or delete
- removed comments are gone for the author as well as for others
- unhiding a private post brings it back private

The full suites pass.
