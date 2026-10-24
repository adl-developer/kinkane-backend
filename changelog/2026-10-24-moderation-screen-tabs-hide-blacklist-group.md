# Moderation screen: three tabs, hide posts and comments, blacklist groups

**Date:** 2026-10-24

## What changed

The admin Reports screen now works the way the web design shows it:

- **Three tabs, each with its own badge:** User Reports, Group Reports, and Posts & Reviews.
  Each report is filed onto one of them, and each tab numbers its reports in its own series:
  `R001`, `GR001`, `CR001`.
- **Reason chips:** the app can send the reason the reporter picked ("Harassment",
  "Spam / Unsolicited promotion"), and the queue shows it alongside their own words.
- **Posts & Reviews cards:** each one says whether the content is a review, a post or a
  comment, which book it's about, and whether it's already hidden.
- **Hide Review / Hide Post / Hide Comment:** the content disappears for everyone except its
  author, who still sees it marked as hidden and gets an email explaining why. It can be undone.
- **Blacklist Group:** the group disappears for everyone, owner and members included, and each
  of them gets an email. It can be undone.

Both actions close every pending report about the same thing.

## Why

The web design for the Reports page has these three tabs, reason chips, and Hide and
Blacklist Group actions. The backend only had one queue, one reference series, and actions
for people, not content or groups. The client's answers:
- Reason labels come from the app.
- Hidden content is reversible, and its author is emailed.
- A blacklisted group's owner and members are emailed.
- Group types ("Book Club") are coming out of the design, so they're not built.

## Data / API shape

**Migration `0090_admin_reports_redesign`:**
- `user_reports.category` (`user` | `group` | `content`) and `user_reports.reason_category`.
  Existing reports are backfilled onto their tabs.
- Three sequences for the reference series. `R` carries on after the highest existing
  number; `GR` and `CR` start at 1. References already issued are left unchanged.
- `posts.hidden_at`, `hidden_by` and `hidden_was_public`.
- `comments.hidden_at` and `hidden_by`.
- `group_book_comments.hidden_at` and `hidden_by`.
- `groups.blacklisted_at`, `blacklisted_by` and `blacklist_reason`.

**Filing (`POST /api/v1/reports`):** an optional `reasonCategory` (≤100 chars) on both kinds of
report. The response includes `category` and the new reference.

**Queue (`GET /admin/console/reports`):**
- A `?category=user|group|content` filter.
- `pendingByCategory` for the tab badges.
- Each report gains `category` and `reasonCategory`.
- `cited` gains `kind: review | post | comment | groupComment`, `hidden` and `book { id, title }`.
- `reportedGroup` gains `memberCount` and `blacklisted`.

**New actions**, each taking a report id:
- `POST /admin/console/reports/:id/hide` and `/unhide`
- `POST /admin/console/reports/:id/blacklist-group` and `/unblacklist-group`

**App-facing:** posts, comments and book-club comments gain `isHidden`. It's only ever true for
the author, the one person who still sees hidden content.

**Emails:** `content-hidden` goes to the author, and `group-blacklisted` goes to the owner and
every active member.

## Non-obvious decisions

- **A hidden post is made private.** Every read path already keeps private posts to their
  author, including feeds, book pages, search, profiles, mentions and friend book pages. So
  hiding reuses one rule that's already enforced everywhere instead of adding a new check to
  each path. The old visibility is remembered, and unhiding restores it. If the author switches
  a hidden post to public, it stays private, and their choice is applied when it's unhidden.
- **Comments are filtered directly.** Comments have no private flag, so `hidden_at` is checked
  next to the existing block filter wherever comments are listed or counted, and when they're
  liked or replied to. A hidden book-club comment takes its replies with it: they can only be
  reached through it.
- **Mentions follow the content.** A hidden comment, or anything in a blacklisted group, is
  readable only by its author or owner in the mentions list.
- **A blacklisted group behaves as if it doesn't exist.** Opening, listing, searching, joining,
  editing, uploading a photo and deleting all answer 404, for the owner too. Blocking delete
  keeps the group intact so the decision can be revisited.
- **A report citing content is a `content` report.** Its target is still the author, so the
  existing **Blacklist User** action still works on it.
- **Idempotent actions.** Hiding something already hidden, or blacklisting a group already
  blacklisted, sends no second email but still closes any new reports.
- **No email when an action is undone.** The client asked only for emails on the action itself.

## Out of scope

- **Group type labels:** being removed from the design.
- **Restoring held mention notifications:** a hidden comment's mention notifications aren't
  re-sent when it's unhidden. A post's are, the same way as when its author makes it public.
- **Old notifications:** existing notifications pointing at hidden content stay in people's
  feeds. Tapping one gets the usual "not found".
- **Client work:**
  - The app needs to send `reasonCategory` and show `isHidden` to authors.
  - The console needs the tabs, badges, chips and the four new actions.

## How it was verified

`admin-moderation.integration.test.ts` runs against a scratch Postgres. It covers:
- reports landing on the right tab with R/GR/CR references and the reason label
- review vs post, the book title, and group member count in the queue
- hiding a review:
  - other people get 404 and it's gone from the book page
  - the author still sees it with `isHidden`
  - both reports on it close, and exactly one email goes out
  - unhiding makes it public again
- a hidden post staying private when its author makes it public, then honouring that on unhide
- hiding a comment: gone from the list and the count for others, likes refused, and the author
  still sees it
- hiding a book-club comment: its replies and likes give 404 to others
- blacklisting a group:
  - 404 for owner, member and stranger
  - gone from discovery and the owner's own list
  - joining and deleting refused
  - owner and member emailed, both reports closed
  - lifting the blacklist restores it
- refusals: hiding when nothing is cited, and blacklisting a group from a report about a person

The existing report, blocking and full integration suites pass, as do the unit suite and the
typecheck.
