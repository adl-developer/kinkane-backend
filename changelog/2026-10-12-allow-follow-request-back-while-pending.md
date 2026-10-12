# You can send a follow request back to someone whose request to you is still waiting

## What changed

If Ama has sent Kofi a follow request and he hasn't answered it yet, Kofi can now send Ama a follow
request of his own. Before this, `POST /api/v1/users/{userId}/follow` refused him with a 409
(`INCOMING_FOLLOW_REQUEST_PENDING`) and told him to accept or decline hers first.

Now both requests can be pending at the same time. Each person gets their own `friend_request`
notification, and each request is accepted or declined separately. If Kofi accepts Ama's request,
Ama follows Kofi, and his request to her stays pending until she answers it.

API shape:

- **`POST /users/{userId}/follow`** returns 201 in this case. It no longer returns the
  `INCOMING_FOLLOW_REQUEST_PENDING` code or a `requestId` in any response. The remaining 409s are
  unchanged: "Follow request already sent" and "You are already following this user".
- **`incomingFollowRequest`** stays on the profile (`GET /users/{userId}`) and on people search
  results, with the same shape. It now means "offer Accept/Decline". It no longer means "hide the
  Follow button". The app can show both.

## Why

Follows work one way, like Instagram. Ama asking to follow Kofi is a different relationship from
Kofi asking to follow Ama. Making Kofi answer her request before he could send his own linked the
two relationships for no good reason. It also forced a decision on him that he might not have
wanted to make yet. This reverses the rule added on 2026-09-28 (see
`2026-09-28-follow-request-already-received.md`).

## Decisions

- **The other person's request is no longer looked at.** The send logic now checks only the
  caller's own request: already pending gives a 409, already accepted gives a 409, declined is sent
  again, and none creates a new one. The query for the reverse request is gone with it.
- **The 409 code is removed rather than kept unused.** The server will never send it again, so the
  API docs no longer list it. An app that still checks for it simply never sees it.
- **Accepting one request does nothing to the other.** Accepting Ama's request doesn't
  automatically send, accept or cancel Kofi's request to her. Each person still approves who
  follows them.

## Out of scope

- App changes. Where the app currently shows only Accept/Decline for someone who has asked to
  follow you, it can now also show a Follow button. That is a client decision.
- The old "two people tap Follow at the same moment" race no longer matters, because crossed
  pending requests are now allowed.

## How it was verified

- The unit tests for the send decision were rewritten to cover each state of the caller's own
  request.
- A new integration test sends requests both ways, checks that both are pending with one
  notification each, then accepts one and checks the other is still pending. With the service
  reverted to `main`, that test fails.
- The full integration suite (112 tests) passed against a scratch Postgres. The unit suite (1418
  tests) and the type check also pass.
