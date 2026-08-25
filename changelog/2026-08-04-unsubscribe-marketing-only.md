# Unsubscribe now means marketing, not everything

## What changed

Clicking **Unsubscribe** in an email footer used to switch off three things:
book recommendations, reading reminders, and follow-request notifications. The
confirmation page told the reader they'd stop receiving "marketing or
notification emails". Neither half was right.

Someone who unsubscribed from a book recommendation also stopped hearing that
people wanted to follow them — a person reaching out, quietly suppressed by a
marketing opt-out. Meanwhile the newsletter, the one genuinely promotional email
we have, was not affected by unsubscribe at all and carried no unsubscribe link
in the first place.

Unsubscribe now covers promotional email only:

| Unsubscribe stops | Unsubscribe leaves alone |
| --- | --- |
| Newsletter | Follow requests and acceptances |
| Book recommendations | Trial ending |
| Reading reminders | Subscription and billing |
| Weekly digest | Password, verification, account security |

The confirmation page says exactly this rather than promising more than it does.

Two smaller corrections fall out of the same rule:

**The newsletter now carries an unsubscribe link and honours the opt-out.** It
previously did neither — its own comment claimed the branded shell added a
footer link, but the call omitted the argument that renders one. Marketing email
with no way to opt out is a CAN-SPAM/GDPR problem, so this was the most
important line in the change.

**Follow-request, welcome and trial-ending emails no longer show an unsubscribe
link.** They keep sending after an unsubscribe, so a link there handed the
reader a confirmation page for something that didn't stop. These are
transactional and don't require one. Follow-request email remains switchable
from Settings, under its own toggle.

## Likes and comments never send email

Post likes and post comments notify by push and the in-app feed only. That was
already the behaviour — but only by accident: `post-like.ts` and
`post-comment.ts` templates, their queue job types and their worker cases all
existed, fully written, with nothing anywhere enqueuing them. One wired-up call
site away from mailing a reader every time somebody liked a post.

All of it is deleted. The `likes` and `comments` preferences remain and gate
push and the in-app feed, which is all they ever did.

## Data shape

One new column on `notification_preferences`:

| Column | Notes |
| --- | --- |
| `marketing_emails` | boolean, default true — gates the newsletter, which had no gate at all before |

The preference flags now fall into two groups, and the split is what unsubscribe
acts on:

- **Promotional** — `marketing_emails`, `new_book_suggestions`,
  `rate_review_reminders`. Cleared together by one click.
- **Everything else** — `friend_requests`, `comments`, `likes`. Never touched by
  unsubscribe; managed in Settings.

`GET`/`PATCH /api/v1/user/notification-preferences` both gained
`marketingEmails`. Additive — existing clients are unaffected.

## Migration backfill

Users who already clicked the old unsubscribe have `friend_requests = false` and
no marketing flag. The migration finds them by the signature the old route left
behind — all three of its flags false together — and sets `marketing_emails =
false` (so their unsubscribe still covers the newsletter it now governs) and
`friend_requests = true` (so it stops suppressing follow requests).

A reader who turned all three off by hand in Settings is indistinguishable from
one who clicked unsubscribe, and will get follow-request email switched back on.
Accepted deliberately: it's rare, it's one toggle to undo, and the alternative
leaves every genuine unsubscriber under the old rule forever.

## Decisions worth recording

**The newsletter opt-out check runs in the queue worker, not at the call site.**
The newsletter job carries only an email address, with no user context, so the
gate is keyed by address (`isMarketingEnabledByEmail`). Putting it at the single
choke point every newsletter passes through means future campaign or admin
tooling cannot skip it by forgetting to check. A marketing send that misses the
opt-out is a compliance incident, not a bug worth trusting callers with.

**The route builds its update from `UNSUBSCRIBE_FLAGS`** rather than listing
columns inline, so adding a promotional category to that constant is enough for
unsubscribe to cover it. The previous drift — route and confirmation copy
disagreeing about what unsubscribe did — came from those living in two places.

## Out of scope

**Book reminders and the weekly digest still have no sender.** Both have
templates, job types and (now correct) preference gates, but nothing triggers
them: no reminder cron exists, and `weekly-digest.cron.ts` is still a stub with
its body commented out. Their flags are wired correctly and ready; the senders
are follow-up work. Until then, "reading reminders" is a category a user can opt
out of but would never have received.

**Non-user newsletter recipients.** `isMarketingEnabledByEmail` returns true for
an address with no account, and the unsubscribe route can't record an opt-out
for one either. Fine today, since newsletters only go to registered users. If we
ever mail a lead list, that needs a real suppression table first.

## Verification

`npm test` — 91 tests pass, including two new files:

- `unsubscribe-scope.test.ts` — asserts unsubscribe clears exactly the three
  promotional flags and never `friendRequests`, and that no post-like or
  post-comment email job or sender exists.
- `email-unsubscribe-footer.test.ts` — renders each email through a mocked
  SendGrid and asserts the newsletter has an unsubscribe link while welcome,
  follow-request and trial-ending do not.

`npx tsc --noEmit` is clean apart from a pre-existing unrelated error in
`gardners-dropship/connection.service.ts` (`ssh2-sftp-client` declared in
`package.json` but not installed locally).
