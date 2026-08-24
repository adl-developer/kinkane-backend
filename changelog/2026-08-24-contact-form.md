# The Contact Us form now reaches somebody

## What changed

`POST /api/v1/contact` — name, email, subject, message. Public, rate limited to
three an hour per IP, honeypot-protected. The message is written to a new
`contact_messages` table and then emailed to the support inbox.

`SUPPORT_INBOX` is the new environment variable that decides where it lands.

## Why

The footer of every page in the web designs links to Contact Us, and the mobile
page has the screen drawn. There was no endpoint, so the link went nowhere.

## Non-obvious decisions

**Stored first, emailed second, and a failed send does not fail the request.**
The email is what anyone actually reads, but it is also the part that silently
breaks — a provider outage, a mistyped support address, a bounce. A customer who
has just described a problem should not be told "something went wrong" because
our mail provider is having an afternoon. From their side the message was sent,
and it was: the row exists. `emailed_at` stays null on the ones that need
chasing.

**The honeypot answers 201, not 400.** Telling a script which field gave it away
is free tuning information. Bot submissions are dropped silently and nothing is
stored.

**`replyTo` carries the sender; `From` stays our verified address.** Putting the
customer's address in `From` would fail SPF and land support mail in spam.
Answering the notification in a mail client still goes back to the customer.

**No admin screen, deliberately.** The designs do not have one, so this stores a
record nobody reads day to day. That is the point — it is a safety net for when
the email path fails, not a support inbox of its own.

**Optional auth.** Most senders are signed out — the people most likely to need
the form are the ones who cannot get into their account. When a token is
present the account is attached, so support can see who they are talking to
rather than trusting the name typed into the form.

## Explicitly out of scope

**Reviews**, the other P1 item in `docs/design-gaps-plan.md`, was deliberately
skipped for now: the PDP Reviews tab needs a decision about whether it shows
reader ratings or editorial press quotes, and neither is built.

**Any admin view of `contact_messages`.** Read them with SQL, or from the
support inbox.

**Auto-reply to the sender.** No "we got your message" email exists.

## Verification

Exercised live against the local database with the server running:

- A valid submission returns `201 {"received":true}` and lands in
  `contact_messages` with `emailed_at` set.
- A submission with the honeypot filled returns the same `201` and stores
  **nothing**.
- Empty name, bad email and empty message return `400` with per-field errors.

Note: because the local `.env` carries a live Resend key, that test sent one
real email to `no-reply@kinkane.app` (the `EMAIL_FROM` fallback, since
`SUPPORT_INBOX` is unset).
