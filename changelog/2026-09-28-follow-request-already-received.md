# Stop a follow request going back to someone who already sent you one

**Date:** 2026-09-28

## What changed

If Ama sends Kofi a follow request, Kofi can no longer send one back to Ama
while hers is still waiting. He's told she has already asked, and the app is
given what it needs to let him accept or decline instead.

Two parts:

**`POST /api/v1/users/{userId}/follow`** now returns `409` when the person
being followed has a pending request to the caller:

```json
{
  "error": "Ama Boateng has already sent you a follow request. Accept or decline it instead.",
  "code": "INCOMING_FOLLOW_REQUEST_PENDING",
  "requestId": 902
}
```

`requestId` is her request, ready for
`PATCH /users/follow-requests/{requestId}/accept` (or `/decline`). The
existing 409s ("Follow request already sent", "You are already following this
user") are unchanged and carry no `code`.

**`GET /api/v1/users/{userId}`** now includes `incomingFollowRequest`:

```json
"incomingFollowRequest": { "requestId": 902, "requestedAt": "2026-09-28T20:48:04.353Z" }
```

or `null`. When it is set, the profile should show Accept/Decline rather than
a Follow button, so the 409 above is a fallback rather than something readers
normally hit.

## Why

Before this, both people could end up with a pending request to the other.
Each was waiting on the other for what is, from their side, the same
connection, and neither request resolved the other. The receiver already has a
one-tap way to settle it — accept — so the server sends them there.

## Decisions

- **Only a *pending* incoming request blocks.** Follows go one way. If Kofi
  has already accepted Ama, she follows him, and him following her back is a
  separate relationship — still allowed. If he declined her, that request is
  over and he can follow her.
- **The caller's own request is answered first.** Someone already following,
  or already waiting, gets that message whatever the other side looks like.
  That includes crossed pending requests created before this change: the
  caller hears "already sent", which describes what they did.
- **A declined request of your own doesn't get around it.** Re-sending one
  normally resets it to pending, but a pending request coming the other way
  still has to be answered first.
- **The decision is a pure function** (`decideFollowRequest` in
  `users.service.ts`), so every combination is unit-tested without a database.
- **The route moved from `wrap` to `wrapHttp`**, which passes a thrown error's
  `code` and `details` into the response body. The controller's own
  try/catch only ever returned the message. A side effect: an unexpected
  error on this endpoint now returns the global handler's generic 500 rather
  than the raw error message.

## Out of scope

- Two people tapping Follow on each other at the same instant can still both
  get through, since each check happens before either insert. Closing that
  would need a lock across both rows; it's rare enough to leave.
- The OpenAPI `UserProfile` schema had already drifted from what the endpoint
  returns (`followState`/`joinedYear`/`canViewShelf` there, `followStatus`/
  `yearJoined` and no `canViewShelf` in the code). Only the new field was
  added; the rest is a separate fix.

## Verified

- `src/__tests__/follow-request-decision.test.ts` — 9 cases covering each
  combination of outgoing and incoming request state.
- End to end against a local database with the real app: A requests B → B's
  view of A shows `incomingFollowRequest` → B following A gets the 409 with
  A's `requestId` → B accepts with that id → the field clears and B can
  follow A back (201).
