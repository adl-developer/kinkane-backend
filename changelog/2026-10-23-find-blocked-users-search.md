# Find people you've blocked in search, so you can unblock them

Blocking hid both people from each other's search. That left no way to reach
someone you had blocked except the Blocked users list. This change lets
**the person who blocked** find them again in people search and in the
@-mention list, and open their profile to unblock.

## What changed

- **People search** (`GET /community/search`, `filter=users` or `all`):
  - People you've blocked now appear, with `followStatus: "blocked"`, the same
    value as on the profile. The app shows Blocked/Unblock on the row instead
    of Follow.
  - People who've blocked you still never appear.
- **@-mention suggestions** (`GET /community/mention-suggestions`):
  - People you've blocked are listed too, with a new `isBlocked: true` field.
    Every other suggestion has `isBlocked: false`.
  - People who've blocked you are still left out.
- **Nothing else moves.** Their posts stay out of the feed and post search,
  their comments stay hidden, and you still can't tag them. Picking a blocked
  person from the list leaves their handle as plain text, as typing it always
  did. The profile is still the limited one, with Unblock.

## Decisions worth knowing

- **One way only.** The blocker needs to find the person to undo the block. The
  person blocked has no use for finding the blocker, and seeing them would defeat
  the block.
- **People-finding only.** A new one-way filter, `notBlockedViewer`, hides only
  people who blocked the viewer. It is used by people search and the mention
  list and nowhere else. Every content filter keeps the two-way
  `notBlockedBetween`.
- **Blocked people in the mention list.** The client asked for this. The
  suggestion carries `isBlocked` so the app can mark it and avoid inserting a
  handle that won't link.

## Testing done

- `user-blocks.integration.test.ts`:
  - Search: the blocker finds the blocked person by name and by @handle, with
    `followStatus: "blocked"` and a matching `total`. The blocked person finds
    nothing. A bystander sees an ordinary result. Post search still hides
    posts both ways.
  - Suggestions: the blocked person's suggestions leave out the blocker. The
    blocker's suggestions list the blocked person with `isBlocked: true`, and
    tagging them from either side still stays plain text with no mention
    stored.
- The full unit suite, plus the mentions and search follow-status integration
  tests, pass.
