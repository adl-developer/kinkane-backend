# Email now sends through Resend instead of SendGrid

## What changed

Every outgoing email — all 17 sends across transactional, notification,
marketing and report templates — now goes out through Resend. Nothing about the
mail itself changed: same sender address and display name, same subjects, same
HTML layout and plain-text bodies, same unsubscribe footers on exactly the mail
that had them before, same BullMQ queue, retries and priorities in front of it.
Only the provider on the other end of the API call is different.

## Why

We're consolidating on Resend. The sending domain and sender identity were
already what we wanted, so this was a provider swap and nothing else — kept
deliberately behaviour-neutral so that if delivery regresses, the provider is
the only variable that changed.

## Shape of the change

`src/lib/sendgrid.ts` is replaced by `src/lib/resend.ts`, which exports the same
two things under new names: `FROM` and a `sendEmail(msg)` function taking
`{ to, from, subject, html, text }`. Templates changed by one import line and
one call name each.

Two things the two providers genuinely disagree about, and how each was settled:

- **Sender format.** SendGrid took `{ email, name }`; Resend takes a single
  RFC 5322 string. `FROM` is now `"Kinkane <no-reply@kinkane.app>"`, composed
  from the same unchanged `EMAIL_FROM` / `EMAIL_FROM_NAME` env vars — the
  address and display name on a delivered email are byte-for-byte what they
  were.

- **Failure signalling.** This is the one that would have bitten us silently.
  SendGrid's client rejects its promise when a send fails; Resend *resolves*
  with `{ data, error }` and leaves the error for the caller to notice. Awaiting
  it directly would have made every rejected send look successful to the email
  worker, so the job would be marked complete and never retried. `sendEmail`
  therefore inspects the result and throws, which keeps the queue's existing
  3-attempt backoff doing what it already did.

## Left out of scope

The newsletter used to request click and open tracking per message. Resend has
no per-message equivalent — tracking is a per-domain toggle in the Resend
dashboard — so those fields are gone from the code and the setting has to be
turned on under **Domains → Tracking** instead. This is the only behavioural
difference in the migration, and it is a dashboard step, not a code one.

Also unchanged: no `List-Unsubscribe` header was added, no templates were
reworded, and bulk newsletter sending still goes one recipient per job rather
than using Resend's batch endpoint.

## Verification

`tsc --noEmit` clean; full suite 91/91 passing, including
`email-unsubscribe-footer.test.ts`, which asserts the unsubscribe link appears
on the newsletter and on nothing else — its provider mock was repointed at the
new module. Booting `src/lib/resend.ts` against the real `.env` resolves `FROM`
to `Kinkane <no-reply@kinkane.app>`, matching the previous sender exactly.

No mail was sent to a real inbox as part of this change — worth doing once
against a live address before this reaches production, since domain
verification in Resend is the one failure mode the test suite cannot see.
