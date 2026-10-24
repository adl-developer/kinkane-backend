# A blacklisted account's profile and activity disappear for everyone else

**Date:** 2026-10-24

## What changed

When an account is blacklisted, everything they put into the community disappears for everyone
else:
- **Profile:** their profile, shelf and follower/following lists answer 404, as if the account
  didn't exist. That includes for someone who had blocked them and would otherwise see their
  profile.
- **Posts and comments:** their posts, reviews and comments drop out of feeds, book pages, comment
  threads and comment counts. Opening one by id is a 404.
- **Search and mentions:** they're left out of people search and post search. Nobody can tag them,
  and their mentions of other people drop out of the mentions list.
- **Groups:** they're left out of group member lists, friend pickers and invites, and their
  book-club comments disappear.
- **Follows:** nobody can follow them. Their pending follow requests, either way, are no longer
  listed or counted, and can't be accepted.

Nothing is deleted. Lifting the blacklist brings it all back.

## Why

The "Your account has been blacklisted" email tells people their profile and existing community
activity "will no longer be visible to other members". Before this, a blacklist only stopped them
signing in and buying, and everything they'd written stayed up.

## Data / API shape

- **No migration and no new fields.** Responses just stop including the account.

## Non-obvious decisions

- **A blacklist is its own filter, not a kind of block.** It's applied beside each block filter
  rather than inside it, because the two differ: a block leaves a limited profile and a visible
  place in book clubs, while a blacklist leaves nothing.
- **A blacklisted member stays a member.** They're just not listed, so lifting the blacklist puts
  them back where they were.
- **Opening a post or liking a comment checks "blocked or blacklisted" in one query,** rather than
  two lookups one after the other.
- **Like counts still include their likes,** by the client's decision.

## How it was verified

New `blacklisted-account.integration.test.ts`:
- their profile, shelf, review, comment, search result, group membership and book-club comment are
  gone for others, and following them is refused
- everything returns when the blacklist is lifted
- someone who blocked them gets a 404 too
- their follow requests are neither listed nor acceptable

The reviews-list unit test now expects the blacklist filter. The full suites pass.
