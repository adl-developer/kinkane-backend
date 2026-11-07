# Restored emails: accounts, groups, and posts, comments and reviews

## What changed

When a moderator undoes a moderation decision, the person it affected is now emailed. Before
this, nobody was told anything when something was given back:

| Admin action | Endpoint | Email |
|---|---|---|
| Lift a customer's blacklist | `DELETE /admin/console/customers/:id/blacklist` | "Your account has been restored", to the customer |
| Lift a group blacklist | `POST /admin/console/reports/:id/unblacklist-group` | "Your group has been restored", to the group's owner |
| Unhide a post, comment or review | `POST /admin/console/reports/:id/unhide` | "Your post / comment / review has been restored", to its author |

The three emails follow the "User restored", "Group restored" and "Post, comment, review
restored" frames on the Email Template page of the web eCommerce Figma. They use a pale green
version of the moderation-notice layout, where the removal notices use sand and gold, and they
are signed by "The Kinkané Trust & Safety Team".

## Decisions

- **The account email replaces the earlier "reinstated" draft.** That draft was written before
  there was a design and was never wired up. The Figma copy now replaces it.
- **"Following a further review", not "a review of your appeal".** An admin can lift a
  blacklist without anyone appealing, so the design's wording would sometimes be untrue.
- **A post that was private before it was hidden goes back to private.** Its email therefore
  says "Restored" instead of "Restored — visible to the community", and it doesn't say the post
  is visible on Kinkané again. Comments and public posts keep the design's wording.
- **Groups handed to Kinkané Admin stay there.** Lifting an account blacklist doesn't return
  the groups the account owned, and the email doesn't mention them.
- **Only real changes send email.** Lifting a blacklist that is already lifted, or unhiding
  something that isn't hidden, returns `changed: false` and emails nobody.
  `DELETE …/customers/:id/blacklist` used to report `changed: true` every time. It now reports
  `false` for an account that wasn't blacklisted.
- **Emails never block the action.** If the email can't be queued, the restore still stands and
  the failure is logged, just as with the removal notices.

## API shape

`POST …/unblacklist-group` now also returns `emailed` (1, or 0 when there was nothing to do),
just as `blacklist-group` does. No other response shapes changed.

## Out of scope

- The Community Guidelines are named but not linked, because there's no page to link to yet.
- Group members aren't emailed when a group is restored, only its owner.

## Verified

Integration tests on a scratch database cover each email, the private-post wording, and the
no-email repeat for all three actions. All three templates were rendered with Resend stubbed
out and compared against the Figma frames.
