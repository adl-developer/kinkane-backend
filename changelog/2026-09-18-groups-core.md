# Book clubs: create, view, edit and delete a group

**Date:** 2026-09-18

## What changed

Readers can now create a book club, give it a name, description and photo,
make it public or private, and delete it again. This is the first slice of the
Groups feature from the September design update — the foundation that
membership, invitations, notifications and search build on top of.

Nothing about joining or inviting ships here. A group created today has exactly
one member: its owner.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/groups` | Create. **Requires Kinkané Plus.** 10/day per user. |
| `GET` | `/api/v1/groups` | Browse, newest first. |
| `GET` | `/api/v1/groups/mine` | Groups you belong to — the profile's "Your groups". |
| `GET` | `/api/v1/groups/:groupId` | The group, plus what you may do with it. |
| `PATCH` | `/api/v1/groups/:groupId` | Owner only. Edit or change privacy. |
| `DELETE` | `/api/v1/groups/:groupId` | Owner only, password-confirmed. |

`GET /:groupId` returns a `viewer` block alongside the group:

```json
{
  "group": { "id": 12, "name": "Books & Friends", "privacy": "private", "memberCount": 34, "...": "..." },
  "viewer": { "membership": "none", "canSeeMembers": false, "canInvite": false, "canEdit": false, "canJoin": false }
}
```

The app picks which of the four group-detail layouts to draw from `viewer`
rather than re-deriving the privacy rules client-side. Keeping that decision on
the server is what stops the rules drifting between iOS, Android and the next
surface that renders a group.

## Non-obvious decisions

**A private group is unjoinable, not secret.** Anyone signed in can see a
private group's name, image, description, owner and creation date — that is
exactly what the "you need an invite" screen renders, and it would be
unreachable if private groups were hidden from discovery. Only the member list
and the ability to join are withheld. Private groups therefore appear in
browse, search and other people's profiles.

**A non-owner editing or deleting gets 404, not 403.** Ownership is folded into
the `WHERE` clause, so "no such group" and "not yours" are the same zero-row
result. This is deliberate: a 403 would confirm that a given group exists and
belongs to someone else. Same shape as deleting a community post.

**Only creating a group needs Plus.** Founding a club is the "create durable
content other people consume" side of the gate that post and comment creation
already sit behind. Joining, browsing and (later) inviting stay free — gating
joins would make a Plus member's invitations useless to their friends, which is
the opposite of what an invite feature is for.

**Deleting accepts a password *or* a fresh sign-in token.** Social-login
accounts have no password hash, so a password-only gate would make it
impossible for a Google or Apple user to delete their own group. This reuses
`authService.verifyOwnership`, the same call the Change Plan flow makes. The
client needs a "Confirm with Google" variant of the confirmation sheet for
those accounts.

**Deleting your account deletes the groups you own.** Cascade, matching how
posts behave. The alternative — auto-transferring to some other member —
silently makes someone the owner of a community they never volunteered to run.
Transfer-of-ownership is a later change to one FK action plus a hook, not a
data model change.

**`member_count` is stored, not counted.** "34 users joined" appears on five
different list surfaces; counting per row is either an N+1 or a `GROUP BY` that
defeats the ranked-then-limited shape group search will need. Every membership
write updates it in the same transaction.

**Membership has no `declined` state — declining deletes the row.** This
diverges on purpose from follow requests, which keep declined rows and revive
them on re-send. Nothing in the design consumes a declined state, and keeping
the row would force every future re-invite to be an update-or-insert against
the unique index. Worth knowing before "fixing" it back.

**`status = 'requested'` exists in the enum but has no code path.** The design
contradicts itself on private groups — the detail screen says invite-only, the
Edit screen's copy says "invited and approved". The screen a real user sees
won, so this ships invite-only. The value is reserved now because extending a
Postgres enum later is a separate non-transactional statement; adding
request-to-join becomes a code change with no migration.

## Data model

Two new tables ([groups.ts](../src/db/schema/groups.ts)), migration
`0063_groups.sql`.

`groups` — `owner_id` (cascade), `name`, `description`, `photo_url`, `privacy`
(`public|private`), `member_count`, `search_vector`, timestamps. Check:
`member_count >= 0`.

`group_memberships` — `group_id`, `user_id`, `status`
(`invited|requested|active`), `invited_by` (set null), `joined_at`, timestamps.
Unique on `(group_id, user_id)` — the guard that will make batched invite
inserts safe. Checks: `joined_at` is set exactly when the row is active, and a
request has no inviter.

The migration is hand-edited past what drizzle-kit generates, with the
reasoning inline: `search_vector` is a `GENERATED ALWAYS` column (it cannot
drift out of sync with name and description the way a trigger-maintained one
can), and the two GIN indexes backing search — one on the vector, one
`gin_trgm_ops` on `name` — cannot be expressed in the schema DSL.

## Also in this change

`isCloudinaryUrl` moved out of the profile-settings controller into
[lib/cloudinary-url.ts](../src/lib/cloudinary-url.ts). Groups need the same
check on their photo, and this validation is the only thing standing between a
user-supplied string and a stored image reference — the path-prefix half in
particular is what stops someone hotlinking another tenant's images off
Cloudinary's shared domain. It now has its own tests.

## Out of scope

Joining and leaving, invitations, the members list, group-invite notifications,
group search, the Community "Groups" tab and Report Group are all later phases.
`GET /users/:userId/groups` — another person's groups — lands with membership.

## Verification

`npm test` — 887 tests across 61 files pass, including 15 new ones covering the
viewer-capability matrix (four relationships x two privacy settings) and the
Cloudinary URL predicate. Typecheck clean. The migration needs applying with
`npm run db:migrate` before `npm run test:endpoints`, which is what catches a
schema column declared without a migration.
