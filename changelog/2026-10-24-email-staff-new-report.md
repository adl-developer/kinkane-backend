# Email staff when someone files a report

## What changed

Every new report (about a user, a post, review or comment, or a group) now sends
an email to the team, as well as adding the existing "New report filed" entry
to the admin console's notification bell. Until now the bell was the only
signal, so a report sat unseen until someone opened the console.

The email follows the client's Figma designs ("User report", "Content Report"
and "Group Report – Admin email notice" on the Email Template page of the web
eCommerce file). It uses a new navy admin-alert layout, so staff alerts look
different from customer email.

| Report | Subject | Details shown |
|---|---|---|
| User | `[Alert] A user has been reported on Kinkané` | reported user, reporter, reason, filed at, reporter's notes, reference |
| Post / review / comment | `[Alert] A review has been reported` (or post / comment) | content type, author, reporter, filed at, reason, reference, quoted text |
| Group | `[Alert] A group has been reported on Kinkané` | group, owner, reporter, filed at, reason, member count, notes, reference |

Every email has a "Review in admin dashboard" button linking to
`ADMIN_CONSOLE_URL/reports`.

## Where it goes

`REPORTS_INBOX` is a new setting that defaults to `contactus@kinkane.app`, the
same default as restock requests. Like the restock alert, the email is sent
from `EMAIL_CONTACT_FROM`. It has its own setting so moderation mail can be
routed elsewhere later without moving restock or contact-form mail with it.

## Decisions

- **Sent through the email queue, never inline.** The reporter doesn't wait on
  the mail provider, and a provider failure is retried (three attempts).
  Queueing never throws either. If Redis is down, the report is still saved, gets
  its reference and appears on the bell; only a log line records that the email
  wasn't queued.
- **Built when the report is filed.** The job carries the full description
  (names, usernames, the quoted text with @mentions rendered), not just a report
  id. The email shows what was reported, even if the content is edited or
  deleted before the worker runs.
- **Reason and notes.** The design shows a picked "Reason" and the reporter's
  "Additional notes". Older app builds send only typed text. In that case the
  typed text is shown as the reason and there are no notes, instead of a blank
  reason above it. Notes that only repeat the reason count as none.
- **Two additions to the design.** The report reference (R014, CR003, GR002) is
  shown because it's how a moderator finds the report in the console. The
  content design has no notes field, but notes are shown there when the
  reporter wrote some, so nothing they said is lost.
- **People are shown as "Name (@username)".** The console lists people by name,
  and the username is what's unique.
- **Times are on Accra's clock and labelled GMT.**
- **Everything user-written is HTML-escaped.** In a content report, some of the
  text is chosen by the person being reported.

## Out of scope

- A deep link to one report. The console's reports page has no search or
  report-id parameter yet, so the button opens the queue, where new reports are
  at the top.
- Digesting or rate-limiting the email. One report means one email. If reports
  arrive in bursts, a digest is the next step.

## Verification

- Unit tests (`report-filed-email.test.ts`) cover recipient and sender, each
  variant's subject and fields, the missing-content case, escaping, the console
  link, and the reason/notes, time and excerpt helpers.
- Integration tests on a scratch Postgres (`admin-moderation.integration.test.ts`)
  file a user, review, comment and group report and check each queued payload.
  They also check that a report is still filed when queueing fails. The existing
  moderation tests now ignore the filing emails when counting the
  content-hidden email.
- All three variants were rendered and compared side by side with the Figma
  frames.
