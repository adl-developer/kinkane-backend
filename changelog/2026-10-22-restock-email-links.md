# Restock emails: the team's link opens the admin console, and new customer wording

**Date:** 2026-10-22

## What changed

**The team email** now links to the console's Restock Requests page instead of
the book's page in the shop. The link is searched to the book's ISBN, so it opens
on that book's card:

```
ADMIN_CONSOLE_URL/restock-requests?q=9780593318256
```

The book card in the email links there too. The email also shows the ISBN on its
own line under the reference:

```
Reference: RR001
ISBN: 9780593318256
```

**The customer email** now reads: "We've received your request to restock this
book. We'll be in touch when it's back in stock." It still links to the book's
page in the shop (`APP_URL/books/{id}`).

## Why

The team acts on a request in the console, where they can see everyone who asked
and mark it fulfilled, not on the shop page. The ISBN is what they quote when
they contact the publisher. The customer wording is the client's.

## Decisions

- **No new URL setting.** In production, `APP_URL` (the shop) and
  `ADMIN_CONSOLE_URL` (default `APP_URL/admin`) are already the web app. Locally,
  `.env` points both at this server, so local emails link there; the client chose
  to leave that as it is.
- **The ISBN is in the body only**, not the subject.
- **The on-screen confirmation is unchanged.** Only the email's wording moved.
- **The console page has to read `q` from its URL** for the link to open filtered.
  That change is in the website repo, on its own branch. Without it, the link
  still opens the Restock Requests page, just unfiltered.

## How it was verified

`restock-request-emails.test.ts` checks the console link (in the HTML, the text
version and the book card), that the team email no longer contains the shop link,
the Reference and ISBN lines, and the customer's new wording with its shop link.
The integration suite checks the ISBN reaches the email.
