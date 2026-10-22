# Email the team, and the customer, about each restock request

**Date:** 2026-10-22

## What changed

A restock request now sends email as well as appearing in the admin console.

**To the Kinkané team**, one email per request:

- **From** `contactus@kinkane.app` (`EMAIL_CONTACT_FROM`), **to** `RESTOCK_INBOX`, which defaults to `contactus@kinkane.app`.
- **Subject:** `Restock request: Wandering Stars (Paperback)`.
- **Body:** "Amara Diallo (amara@example.com) has requested a restocking of this book:", then the cover, title and author, a link to the book on the website, "Please contact your publisher to request restocking of the book." and the RR reference.
- Who asked is named as fully as they allowed: name and email, either one, or "A customer".
- There's no Reply-To, so replies go back to contactus@.

**To the customer**, when there is an address (typed in the form, or a signed-in account's):

- **From** the usual `no-reply@kinkane.app` (`EMAIL_FROM`).
- **Subject:** "We've passed on your restock request".
- **Body:** the book card, then "We've told the Kinkané team you're after this book. They'll be in touch if they can get it back in stock." It doesn't promise a notification, because nobody sends one.

The admin bell entry is unchanged.

## Decisions, and why

All settled with the client on 2026-10-22:

- **A setting of its own (`RESTOCK_INBOX`)** rather than `SUPPORT_INBOX`, so restock mail can move without moving contact-form mail. The default is `contactus@kinkane.app`, so nothing has to be configured. This matters locally: `SUPPORT_INBOX` is unset there and falls back to `no-reply@kinkane.app`.
- **The customer email is capped at 3 a day per address.** The form is public and accepts any address, so without a cap it would let anyone send our emails to a stranger. The request is always stored; only the email is skipped. The count is of requests carrying that address in the last 24 hours, by the database's clock, so it needs no extra column.
- **A failed send never fails the request.** Same pattern as the contact form: save first, then email. `admin_emailed_at` is set only when the staff email actually went out, so a null marks one to look at.
- **The book link is the website's book page** (`APP_URL/books/{id}`), because the admin will usually open it on a computer.
- **"Publisher" is the client's wording** and is kept as written, although restocks are arranged with Gardners.

## Configuration

Two new optional settings, both defaulting to `contactus@kinkane.app`:

```
RESTOCK_INBOX=contactus@kinkane.app
EMAIL_CONTACT_FROM=contactus@kinkane.app
```

`EMAIL_CONTACT_FROM` must be on the domain verified with Resend (kinkane.app).

## How it was verified

- `restock-request-emails.test.ts`: both templates (recipient, sender, no Reply-To, subject, who asked, cover, title, author, link, the publisher line, escaping of what the customer typed, and a book with no cover, author or format).
- `restock-requests.integration.test.ts`, against a scratch Postgres with the email module mocked: the staff email is sent with the right book details and `admin_emailed_at` is recorded; the customer email goes out when there's an address, to a signed-in customer's account address, and not when there's none; the fourth request in a day from one address is stored but not emailed (address case ignored); and a failed send in either email still files the request.
