# The book's cover in the recommendation email

**Date:** 2026-09-06

## What changed

The "We found a book for you" email now shows the book's jacket. The title and
author, which used to be a bare paragraph of text, are now a card: the cover
thumbnail on the left at 96px wide, the title and author beside it, both the
image and the title linking through to the book's page.

Nothing else about the email moves — same subject, same hero band, same reason
line, same CTA, same unsubscribe footer. The plain-text alternative is unchanged.

## Why

This is the one email where the pick is unprompted: nobody asked for it, so it
has to earn its open in the first second. A jacket is how a reader recognises a
book, and it was the one thing the email left out — the title and author alone
made a message about a specific book look like a template.

The cover was already sitting in the row the recommendation query selects from.
It cost one more column to include it.

## How it is wired

`bookCard()` in `src/emails/lib/layout.ts`, alongside the other shared pieces
(`ctaButton`, `otpDisplay`, `quoteBlock`), so the next email that needs to show
a book uses the same card rather than inventing a second one.

The recommendation query in `recommendation-notifications.service.ts` selects
`books.cover_url` and passes it into the queue payload;
`RecommendedBook.coverUrl` is optional, so queued jobs written before this
change still deserialise and send.

## Decisions worth naming

**Two table cells, not flexbox or a float.** Outlook renders mail through Word,
which supports neither. This is the first email surface pairing an image with
text, so it sets the pattern.

**The image carries `width`/`height` attributes as well as CSS.** With images
blocked — the default in a good share of clients — the cell keeps its size and
the `alt` text stands in for the jacket, instead of the card collapsing.

**No cover means no image cell, not a placeholder.** The cell is dropped and the
text takes the full width. A large share of catalogue rows have no jacket on
file, so this path is normal, not exceptional, and a grey box saying "no image"
would look more broken than an ordinary text card.

**Only `https://` covers are hotlinked; an `http://` URL is treated as no
cover.** Gmail proxies remote images and silently drops insecure ones, which
would leave a dead frame in the layout rather than a visible failure.

## Out of scope

- **Auditing how many `cover_url` values are `http://`.** If that number is
  material, the fix belongs in the cover sync that writes the column, not in the
  email that reads it.
- Every other email. The weekly digest and order confirmation also name books
  and could use the same card; they are left alone here.
- Hosting or resizing covers. They are hotlinked at whatever dimensions the
  catalogue stored, constrained to 96px by the browser.

## How it was verified

`tsc --noEmit` clean. Both branches of the card — with a cover and without —
were rendered to HTML through the real `emailLayout` and checked in a browser:
the card sits correctly on the cream panel, the fallback reflows to full width,
and the surrounding email is byte-for-byte what it was apart from the card.

Not yet verified in real mail clients. The Outlook and images-blocked behaviour
above is what the markup is built for, not something observed in Litmus.
