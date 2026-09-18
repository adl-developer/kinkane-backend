# Book clubs (Groups) — client integration brief

**Audience:** whoever builds the Groups screens in the Kinkané apps, and whoever
maintains the admin console.
**Status:** 13 commits on `feat/groups-core`, pushed 2026-09-18 (`83a8946`).
**Not yet merged, and not on staging.**

This document is self-contained. Field-by-field contracts live in the OpenAPI
spec at `GET /openapi.json` (Swagger UI on the same host). **Where this document
and the spec disagree, the spec is correct** — it is generated from the running
code.

Postman collections covering every endpoint here ship alongside this brief:
`Kinkane Groups` (creating and managing a club) and `Kinkane Groups (Part 2)`
(everything else).

---

## 1. What has been built

The whole of the Groups design from the 9/15 Figma update, server-side:

- Creating a club, with a name, description and photo, public or private
- Viewing one, with the right screen for who is looking
- Editing it, changing its privacy, and deleting it
- Joining a public club, leaving, and seeing who is in it
- Inviting friends, accepting, declining, and removing people
- A notification and push when someone invites you
- Clubs in search — the Community "Groups" tab and the Explore toggle
- Reporting a club, which reaches the same moderation queue as everything else

Fourteen new endpoints under `/api/v1/groups`, plus three existing endpoints
extended: community search, reports, and notification settings.

## 2. Two things that will surprise you

Read these before anything else — most of the "is this a bug?" questions come
back to one of them.

**A private club is unjoinable, not secret.** Anyone signed in can see a private
club's name, image, description, owner and creation date, and it appears in
browse and search results. That is deliberate: the "you need an invite to join"
screen would be unreachable otherwise. What is withheld is the **member list**
and the **ability to join** — nothing else.

**Editing or deleting a club you do not own returns 404, not 403.** So does
removing someone from it. That is on purpose — a 403 would confirm that a
particular club exists and belongs to someone else. Do not treat a 404 on those
calls as "the club is gone"; it also means "not yours".

## 3. Gating

**Only creating a club needs Kinkané Plus.** Everything else — joining,
inviting, browsing, searching, reporting — is open to any signed-in reader.
Gating joins would make a Plus member's invitation useless to the friend
receiving it.

Creating without Plus returns **402** with `code: "PLUS_REQUIRED"`, the same
shape as every other gated endpoint. Note that when gating is switched off in an
environment, the check passes everyone, so this will succeed on a free account
in most non-production setups.

Every endpoint in this brief requires a signed-in reader. There are no public
group endpoints.

## 4. The `viewer` block — build your screens off this

`GET /api/v1/groups/{groupId}` returns the club **and** a `viewer` block:

```json
{
  "group": { "id": 12, "name": "Books & Friends", "privacy": "private",
             "memberCount": 34, "description": "...", "photoUrl": "...",
             "createdAt": "2026-09-01T09:00:00.000Z",
             "owner": { "id": 44, "name": "Elisabeth Green", "photoUrl": "..." } },
  "viewer": { "membership": "none", "canSeeMembers": false, "canInvite": false,
              "canEdit": false, "canJoin": false }
}
```

| Field | Meaning |
| --- | --- |
| `membership` | `owner` · `member` · `invited` · `none` |
| `canSeeMembers` | False only for a non-member of a private club |
| `canInvite` | True for **any** member, not just the owner |
| `canEdit` | Owner only |
| `canJoin` | Public clubs only, and only when not already involved |

**Pick which of the four detail layouts to draw from this**, rather than
re-deriving the rules from `privacy` and your own state. The rules live on the
server so they cannot drift between iOS, Android and anything added later.

`memberCount` includes the owner, so a brand-new club reports **1**, not 0.

## 5. The endpoints

### Creating and managing

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/groups` | **Plus.** 10 per day. Returns 201 |
| `GET` | `/api/v1/groups` | Browse, or search with `?q=` |
| `GET` | `/api/v1/groups/mine` | Clubs you belong to — the profile section |
| `GET` | `/api/v1/groups/{groupId}` | The club plus your `viewer` block |
| `PATCH` | `/api/v1/groups/{groupId}` | Owner only. At least one field |
| `DELETE` | `/api/v1/groups/{groupId}` | Owner only. Confirmed — see §8 |

Create body — only `name` is required:

```json
{
  "name": "Books & Friends",
  "description": "A cozy gathering of history enthusiasts.",
  "photoUrl": "https://res.cloudinary.com/<cloud-name>/image/upload/v1/groups/abc.jpg",
  "privacy": "public"
}
```

`privacy` defaults to `"public"` — the Create Group screen has no privacy
control, so a club is born public and changed afterwards from Edit or Privacy
Settings.

**`PATCH` serves both the Edit Group screen and the standalone Privacy Settings
screen.** The latter just sends `{"privacy": "private"}` on its own. There is no
separate privacy route. Flipping a club to private does not remove anyone —
existing members stay; it only stops new people joining uninvited.

### Membership

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/groups/{groupId}/members` | Oldest first, owner at the top |
| `POST` | `/api/v1/groups/{groupId}/join` | Public only. 201 with the new count |
| `DELETE` | `/api/v1/groups/{groupId}/membership` | Leave |

Each member carries `isOwner`. The **owner cannot leave** — that is a 400
pointing at deleting the club instead, because there is no ownership transfer
yet. Joining twice is a 409, and concurrent taps settle to one membership and
one increment.

### Invitations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/groups/{groupId}/invitable-friends` | The picker. `?q=` narrows by name |
| `POST` | `/api/v1/groups/{groupId}/invites` | Up to 50 ids. 30 requests/hour |
| `POST` | `/api/v1/groups/{groupId}/invites/accept` | Returns the new count |
| `POST` | `/api/v1/groups/{groupId}/invites/decline` | |
| `DELETE` | `/api/v1/groups/{groupId}/members/{userId}` | Owner only |

**The picker already excludes anyone in the club or already invited**, so you can
render its result directly — no client-side filtering needed. "Friend" means an
accepted follow in **either** direction, matching the friend count on a profile.

`POST /invites` takes `{"userIds": [12, 44, 91]}` and is **partial success**:

```json
{ "invited": [12, 44],
  "skipped": [{ "userId": 91, "reason": "already_member" }] }
```

Reasons are `self`, `not_a_friend`, `already_member`, `already_invited`. **A
request where every id was skipped is still a 201** — it was understood and acted
on, and `skipped` is the answer. Show the outcome; do not treat it as a failure.

Two behaviours worth knowing:

- **An invitee cannot join around their invitation.** `POST /join` returns 409
  telling them to accept instead. Send them down the accept path.
- **Declining deletes the invitation** rather than recording a refusal, so
  someone can be invited again afterwards. This differs from friend requests
  deliberately.

`DELETE /members/{userId}` covers **both** removing a member and withdrawing a
pending invitation — the owner is severing the same link either way. It never
touches the follow graph (see §10).

## 6. Notifications

Being invited now produces an in-app notification and a push.

The notification appears in the existing feed at `GET /api/v1/user/notifications`
with `type: "group_invite"`, and its `data` carries everything the card needs —
`groupId`, `groupName`, `groupPhotoUrl`, `inviterId`, `inviterName`,
`inviterPhotoUrl` — so no second call is needed to render it.

**It is a stored notification**, so unlike the friend-request item it has a
numeric `id` and a real read state and can be marked read. Accepting or declining
does **not** remove it; it stays as history, like a like or a comment. Re-read
the current state from the club when the card is tapped.

`GET /api/v1/user/notification-preferences` now returns a seventh toggle,
`groupInvites`. It is **not** part of one-click unsubscribe — an invitation is a
person asking you to join something, not marketing — and it never sends email,
matching the existing policy for social activity.

## 7. Search

Clubs appear in `GET /api/v1/community/search` via `filter=groups`. This backs
**both** the Community "Groups" tab and the third option on the Explore
`Books | Authors | Groups` toggle — there is no separate groups endpoint for
Explore.

Responses now carry a `groups` array and `total.groups`. **`total` is an object
of per-kind counts, not a single number** — the spec previously described it as a
number, which was wrong and is now corrected.

Clubs rank by the same rules as people and posts: names starting with the term
first, then names containing it, then near-spellings, then anything mentioning it
in a description. One formula across all three, so the same query orders
consistently wherever results sit side by side.

`GET /api/v1/groups?q=` searches the same way if you want clubs alone.

**Blending books, authors and clubs into one ranked list is not done** — there is
no principled way to compare a book title match against a club name match. Keep
them as three tabs.

## 8. Deleting a club

The owner must re-prove who they are, as with deleting an account. `DELETE` takes
**either**:

```json
{ "password": "..." }        // accounts that have a password
{ "idToken": "..." }         // Google / Apple sign-in
```

**Social-login accounts have no password at all** and will get a 400 if you send
the password form. Those readers need a "Confirm with Google/Apple" variant of
the confirmation sheet, sending a **freshly issued** token — there is a five
minute freshness window. The designed screen currently shows only a password
field, so this variant needs adding.

Deleting is permanent and takes the memberships with it.

## 9. Photos

The server never receives an upload. **Upload to Cloudinary from the client, then
send us the resulting URL** as `photoUrl` — the same arrangement profile photos
already use. URLs on any other host, or under a different Cloudinary account, are
rejected with a 400, and there is a 500-character limit.

⚠️ **This is unverified in production.** The Cloudinary account name is a
server setting, and in at least one environment it was still an unfilled
placeholder — which silently rejects *every* image URL while the server appears
healthy. That is why no Kinkané account currently has a profile photo. Confirm
the production value before relying on club photos or profile photos.

## 10. For the admin console

Reports can now be filed against a club, and the moderation queue returns them
alongside reports about people.

**This will break a console that assumes every report has a reported person.**
On a club report `reportedUser` is `null`. Two things make that manageable:

- **`?targetType=user`** restricts the queue to reports about people — exactly
  the rows and shape it returned before. A console not yet ready for club
  reports can pass this and carry on unchanged. **But while it is applied,
  moderators never see club reports**, so this is a stopgap, not a fix.
- **`targetName`** on every row carries whichever target the report is about, so
  a row can be labelled without branching or touching `reportedUser`.

`reportedBy` is never null. Club and user reports share one `R###` reference
series.

**Moderators can resolve or dismiss a club report but cannot blacklist from one**
(there is no account behind it — that returns a 400) and **cannot delete a club
from the console**. Whether they should be able to needs a decision.

A complaint outlives its target: deleting a reported club keeps the report and
simply forgets which club it named.

## 11. What is not built

- **Ownership transfer.** This is why an owner cannot leave or be removed, and
  why deleting an account deletes the clubs it owns.
- **Request-to-join.** Private clubs are invite-only. The design contradicts
  itself here — the club screen says invite-only, the Edit screen's privacy copy
  says "invited **and approved**" — and the screen a real reader sees won. The
  data model reserves room for it, so adding it later is a code change only.
- **Deleting a club from the admin console.**
- **Club activity** — posts, discussions, shared shelves. Nothing in the 9/15
  update covers what happens *inside* a club beyond membership.

## 12. What we need from you

1. **Confirm the production Cloudinary account name** (§9). Until then, photo
   upload is unverified and may be silently failing for profile photos too.
2. **Reword the member-removal dialog.** It currently reads *"Unfollow Theodore
   Stevens?"* — copy carried over from the follow flow. Removing someone from a
   club does **not** unfollow them, and we have verified that it does not. The
   copy tells readers the opposite of what happens.
3. **Update the admin console** for club reports (§10), or apply the
   `targetType=user` stopgap knowingly.
4. **Add the "Confirm with Google/Apple" variant** of the delete-club sheet (§8).
5. **Decide on invite-only vs request-to-join** for private clubs (§11), if the
   Edit screen's copy reflects an intention rather than an oversight.
6. **Decide whether moderators may delete a club** from the console.

## 13. Checklist for the app build

- [ ] Draw the club detail screen from `viewer`, not from `privacy`
- [ ] Handle 404 on edit/delete/remove as "not yours **or** not there"
- [ ] Show a private club to non-members — name, owner, description — with the
      locked state, not an error
- [ ] Render `skipped` from an invite as an outcome, not a failure
- [ ] Send an invitee to accept, not join
- [ ] Treat a group-invite notification as history that survives accepting
- [ ] Read `total.groups` as part of an object, not a number
- [ ] Offer the social-login confirmation variant when deleting a club
- [ ] Expect `memberCount` to include the owner
