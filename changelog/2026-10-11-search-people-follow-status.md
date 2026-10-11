# People search shows your follow status with each person

## What changed

Every person returned by `GET /community/search` (with `filter=all` or `filter=users`) now carries
two extra fields. They mean the same as on the profile (`GET /users/:userId`):

- **`followStatus`**: your follow request to them. It's `none` (Follow), `pending` (Requested),
  `accepted` (Following) or `declined` (Follow again), plus **`self`** on your own row.
- **`incomingFollowRequest`**: `{ requestId, requestedAt }` when they've asked to follow you and
  you haven't answered, otherwise `null`.

```json
{
  "id": 4412, "name": "Ama Boateng", "username": "ama_reads", "photoUrl": null,
  "followStatus": "accepted",
  "incomingFollowRequest": { "requestId": 902, "requestedAt": "2026-09-28T20:48:04.353Z" }
}
```

Nothing else about search changes: the same people are returned, in the same order, with the same
totals.

## Why

The search results list needs a Follow / Requested / Following button on each row. Without the
status, the app would have to open every profile to know which button to draw.

## Decisions

- **Same values as the profile.** The app can use one piece of code for the button on both screens.
  `declined` is kept rather than shown as `none`, for the same reason.
- **`incomingFollowRequest` is included too.** Following someone back while their request to you is
  still pending is refused with a 409. So a row for someone who has asked to follow you should show
  Accept/Decline, not Follow, exactly as the profile does.
- **Your own row says `self`** rather than being dropped, so results and totals don't change. The app
  just leaves the button off that row.
- **No extra round-trip.** Both fields come from two `LEFT JOIN`s on the existing search query.
  `follow_requests` is unique per sender and receiver, so each person still appears once and the
  total still counts people.

## Out of scope

- Follow status on the authors of results in `posts`. That's a different list with its own UI. Add
  it if the post rows get a Follow button.
- The `@`-mention typeahead (`GET /community/mention-suggestions`), which returns plain user
  summaries.

## How it was verified

- A new integration suite, `community-search-follow-status.integration.test.ts`, checks a real
  search against people in every state:
  - none, pending, accepted and declined;
  - your own row;
  - someone who has asked to follow you;
  - someone you follow who has also asked to follow you;
  - follow rows between other people, which must not leak in.
- It checks each person appears once with the right total, and that the status is worked out for
  whoever is searching.
- With the join direction flipped, three of its five tests fail.
- The live search response was compared field by field against the updated API docs, and matches.
- The full integration suite (93 tests), the unit suite (1373) and the type check pass.
