# Short links: review fixes

A code review of the short-links branch found six problems. This change fixes them.

## What changed

1. **An `@` inside an address is never a mention.** Addresses past the per-text link cap stay as plain text. Before this fix, an `@handle` inside one (`https://medium.com/@kofi/…`) was turned into a mention and notified. Mention detection now skips every address-shaped run of text, whether it was linked or not.
2. **Curly quotes, ellipses, emoji and full-width punctuation end an address.** iOS smart punctuation types `“https://x.com/a”`, and the closing quote was being stored as part of the address. The same happened with `…` or an emoji typed straight after a link. Readers were sent to a page that doesn't exist. These characters now end the address, and trailing curly single quotes and CJK punctuation are trimmed. Accented letters inside a path are still kept.
3. **No short-link rows are written for a refused or empty edit.** Editing a post or comment used to store the new text's links before checking ownership, and so did updating a group's description. A request that ended in a 404 still wrote rows, which let anyone fill the table by editing other people's posts. Links are now stored only after the ownership check, and only when the text actually changed.
4. **Length limits count links at their short-link length.** A short link (34 characters in production) can be longer than the address typed. Text that fit as typed could therefore read longer than its limit, and an edit sending it back was refused. Limits now apply to the text as it will read, with each link counted as its short link. Text over the limit gets a 400 with code `TEXT_TOO_LONG` before anything is stored. The limits now live in one place (`lib/text-limits.ts`) for both the request schemas and this check.
5. **Whole domains can be blocked.** Blocking one link covered one exact address, so the same phishing page came back with `?a=1` on the end. A new `blocked_link_domains` table (migration `0083`) blocks every address on a domain and its subdomains, whenever it was posted. Admin routes, using the admin bearer token:
   - `GET /admin/short-links/domains`
   - `PUT /admin/short-links/domains/:domain` with `{ reason? }`
   - `DELETE /admin/short-links/domains/:domain`

   Links on a blocked domain render as `blocked: true`, and taps get the 410 page without being counted.
6. **The new-comment notification shows the short link.** Its preview was built from the comment as typed, so it carried the original address, which a later block didn't cover. It now uses the rendered text.

## Left as it was

- Mention tokens are still counted at their stored length for the limit. A username can render a few characters longer, which was already true before short links.
- Domain blocking is exact on the domain and its subdomains. There is no wildcard or pattern matching.

## Verification

- Unit tests for each fix: mention skip ranges, curly quotes and emoji, full-width punctuation, accented paths, shown length, and domain normalisation and parent-domain matching.
- Integration tests, against a throwaway database, for each fix:
  - an `@` in the 6th address doesn't create a mention row
  - a refused edit writes no row
  - an over-limit comment is refused with `TEXT_TOO_LONG` and stores nothing
  - a domain block covers an existing address and a later variant, gives a 410 without counting the tap, and lifts cleanly
  - the comment notification preview contains the short link
- Full unit (1508) and integration (165) suites pass.
