# Links typed without http:// or www.

## What changed

Web addresses in posts, comments, reviews, notes and group text become short
links even when typed bare — `google.com`, `bbc.co.uk/news`,
`wikipedia.org/wiki/Dune`. Before, only addresses starting with `http://`,
`https://` or `www.` were picked up, so `goodreads.com/book/1` stayed plain
text.

A pasted Markdown-style link, `[www.google.com](https://www.google.com)`, is
now linked too. Before, nothing in it was linked.

## How it decides

- A bare address must end in `.com`, `.net`, `.org` or `.co.uk`
  (`BARE_DOMAIN_ENDINGS` in `src/lib/link-text.ts`), optionally followed by a
  path. The list is short on purpose: every ending added turns more ordinary
  words-with-dots into links.
- It is not an address when it follows `@` (an email address such as
  `ama@gmail.com`, or a handle), `.`, `/` or a letter, or when more name follows
  (`google.com.au`, `x.community`).
- Bare addresses are stored with `https://` in front.
- Square brackets now end an address, like quotes and angle brackets already
  did. They cannot appear unencoded in an address's path, and treating them as
  part of one made the whole Markdown link fail to parse.

Everything else — trailing punctuation, the five-links-per-text cap, the
username/password refusal, domain blocking — is unchanged.

## Out of scope

- Other endings (`.io`, `.app`, country domains other than `.co.uk`).
- Existing posts are not re-processed; only text written or edited from now on.

## Verified

Unit tests in `src/__tests__/link-text.test.ts` cover bare endings, emails,
handles, longer names and the Markdown case. The full suite passes.
