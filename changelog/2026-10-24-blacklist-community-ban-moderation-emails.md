# Blacklisting becomes a community ban, removed content goes for its author too, and the moderation emails follow the designs

**Date:** 2026-10-24

> **Superseded in part the same day.** Blacklisted accounts can no longer sign in or buy after all.
> See `2026-10-24-blacklist-blocks-sign-in-appeal-email.md`. The rest stands: hiding content from its
> author, the community guard and hidden activity, and the email designs.

## What changed

**Blacklisting an account.**
- Before: it blocked signing in and checking out, and hid nothing.
- Now, matching the "Your account has been blacklisted" email design:
  - **They can still sign in, browse and buy books.**
  - **The community is closed to them.** Every community route answers `403 ACCOUNT_RESTRICTED`
    from their very next request: posts, comments, reviews, groups, profiles, follows, reports and
    mentions.
  - **Their profile and activity disappear for everyone else:**
    - their profile, shelf and follow lists answer 404
    - their posts, reviews and comments drop out of feeds, book pages, threads, counts and search
    - they're left out of group member lists and book-club threads
    - nobody can tag or follow them
  - **They're emailed.**
  - Nothing is deleted, and lifting the blacklist brings everything back.

**Hiding a post, review or comment.** It now removes the content for everyone, **its author
included**. Before, the author still saw it, marked as hidden. The emailed notice now reads "has
been removed … no longer visible on the platform", which is now accurate. Unhiding still restores
it.

**Moderation emails.** All three now follow the Email Template designs: a sand "Community notice" /
"Account notice" band, a cream panel with the details, and an appeal button that opens an email to
`contactus@kinkane.app`.
- **Content removed:** goes to the author. Type, the date it was submitted, and the reason.
- **Group blacklisted:** now goes **to the owner only**. Members no longer get one; the group just
  disappears for them.
- **Account blacklisted:** new.

## Why

The client shared the three email designs and confirmed:
- A blacklist should do what its email says: community locked, bookstore open, profile and
  activity hidden.
- Removed content should be gone for its author too.
- The group notice is for the owner only.
- The emails name the Community Guidelines but don't link them, because there's no page yet.

## Data / API shape

- **No migration.**
- **`403 { code: 'ACCOUNT_RESTRICTED' }`:** on `/community`, `/groups`, `/users`, `/reports` and
  `/user/mentions`, for a blacklisted caller.
- **Sign-in and checkout:** no longer refuse a blacklisted account, so `ACCOUNT_SUSPENDED` is gone.
- **Removed fields:**
  - `isHidden` on posts, comments and book-club comments. Hidden content now never reaches anyone,
    so the flag would always be false.
  - `sessionsRevoked` on the customer blacklist response. A blacklist no longer ends sessions.
- **Email jobs:**
  - `content-hidden` is renamed `content-removed`, and takes `submittedAt` instead of `bookTitle`.
  - `group-blacklisted` loses `isOwner`.
  - `account-blacklisted` is new.

## Non-obvious decisions

- **The lockout is checked per request, by middleware on each community router.** It isn't in the
  sign-in token. That way it bites on the next request and lifts the same way, without anyone
  having to sign out.
- **A blacklist is its own filter, not a kind of block.** It sits beside each block filter rather
  than inside it, because the two differ: a block leaves a limited profile and a visible place in
  book clubs, while a blacklist leaves nothing.
- **A blacklisted member stays a member.** They're just not listed, so lifting the blacklist puts
  them back where they were.
- **The author's own paths now check `hidden_at`:** opening, editing, deleting, their own post
  list, "my review" on book pages, and the friend book page. Hiding still works by making the post
  private, which already keeps it from everyone else. Mentions in removed content now show their
  excerpt to no one.
- **Both blacklist paths send the email:** the customer screen and "Blacklist User" on a report.
  It goes out after the change is committed, never on a re-click.

## Out of scope

- **The Community Guidelines link:** there's no page yet.
- **The app:** it should treat `ACCOUNT_RESTRICTED` as "community unavailable" rather than signing
  out, and drop its use of `isHidden`.

## How it was verified

- **New `blacklisted-account.integration.test.ts`:**
  - A blacklisted account still signs in, gets 403 `ACCOUNT_RESTRICTED` on community routes, and
    is emailed once.
  - Their profile, shelf, review, comment, search result, group membership and book-club comment
    are gone for others, and following them is refused.
  - Everything returns when the blacklist is lifted.
- **`admin-moderation.integration.test.ts` updated:**
  - removed content is 404 to its author: by id, in their own list, and to edit or delete
  - the email is `content-removed`
  - only the owner gets the group email
  - unhiding a private post brings it back private
- **Source-level tests:**
  - the blacklist test now asserts the community guard on every community router, and its absence
    from sign-in and checkout
  - the reviews-list and money-atomicity tests are updated for the new filters
- **Emails:** all three rendered with sample data, with sending stubbed out, and checked against
  the Figma designs.
- **Full suites:** unit, integration and endpoint contract suites all pass.
