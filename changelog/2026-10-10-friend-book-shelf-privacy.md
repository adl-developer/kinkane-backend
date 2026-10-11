# A friend's book page follows their shelf privacy, and stops showing private reviews

## What changed

`GET /community/users/:friendId/books/:bookId` shows one book from another reader's shelf: their
note if it's public, and their rating and review. Who may open it is now decided by that reader's
**shelf visibility**, the same setting that already guards their full shelf
(`GET /users/:userId/books`):

| Shelf setting | Who can open the page (before) | Who can open it (now) |
| --- | --- | --- |
| `public` (the default) | accepted followers only | everyone signed in |
| `friends` | accepted followers | accepted followers |
| `private` | accepted followers | the owner only |
| your own shelf | nobody (you can't follow yourself) | you |

The review on that page now appears only if it's public, or if the caller wrote it.

`GET /users/:userId` (and `/users/by-username/:username`) now returns **`canViewShelf`**, a
boolean saying whether the caller may read this person's shelf. The API docs already promised this
field. The app should check it before showing a shelf tab, rather than working the rule out itself.

## Why

- **The two shelf endpoints disagreed.** You could open someone's public shelf and then get a 404
  when you tapped one of its books, because the book page only looked at the follow graph. And a
  `private` shelf was hidden as a whole but its books were still readable one at a time by
  followers.
- **Private reviews leaked.** The book page fetched the review without looking at its privacy
  setting. Every other place treats a private review as visible to its author only. Followers
  could already read private reviews on this one page, and opening the page to everyone for public
  shelves would have exposed them to strangers too. That's fixed as part of this change.
- **`canViewShelf` was documented but never returned**, so clients had nothing to check.

## Decisions

- **One rule, one place.** The visibility rule is now a single function, `canViewShelf` in
  `users.service.ts`. The full shelf, the book page and the profile flag all use it, so they can't
  drift apart again.
- **A hidden shelf answers 404, not 403.** This is the same response as an account that doesn't
  exist, so nobody can use the endpoint to find out whether someone has an account. The full shelf
  already worked this way. The docs said 403 for both endpoints, and they've been corrected.
- **Private shelf means private, even to followers.** Accepted followers of someone with a
  `private` shelf lose the book page. That's what the setting says. Public reviews by that person
  are still visible in the feed and on the book's own page.
- **Private reviews are hidden from followers too.** This matches the rest of the community code,
  where a private review is visible only to its author.

## Out of scope

- The documented response bodies for this endpoint and for the profile still don't match what the
  server sends (for example `followState` and `joinedYear` in the docs, `followStatus` and
  `yearJoined` in reality). That's pre-existing and deserves its own pass.
- Tidying the three near-identical "who is this person to me" lookups in `users.service.ts` into
  one.

## How it was verified

- A new integration suite, `shelf-visibility.integration.test.ts`, covers every shelf setting for
  four viewers: the owner, an accepted follower, someone with a pending request, and a stranger.
  Each check covers the full shelf, the book page and `canViewShelf` together. It also covers the
  review rules and the "hidden looks the same as missing" response.
- With the review fix temporarily removed, the two private-review tests fail. So the suite catches
  the leak.
- The full integration suite (87 tests) was run against a scratch Postgres. The unit suite (1371
  tests, including a new one for the pure rule) and the type check pass.
