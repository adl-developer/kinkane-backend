# Short links in posts, comments and reviews

## What changed

Web addresses written into user text are now detected, stored, and shown as short links on Kinkané's own domain (`APP_URL/l/<code>`), the way LinkedIn shows `lnkd.in/…`. This covers every text that can hold an @mention: posts and reviews, comments, group descriptions, group shelf descriptions, group discussion comments, and shelf notes.

Every response that returns one of those texts now carries a `links` array next to `mentions` (`descriptionLinks`, `reviewLinks` and `noteLinks` where the mentions key has a prefix). Each entry says where the short link sits in the text and where it goes:

```json
{
  "body": "Loved it. Interview: https://kinkane.app/l/7KQ2M9XA.",
  "mentions": [],
  "links": [
    {
      "url": "https://kinkane.app/l/7KQ2M9XA",
      "target": "https://www.theguardian.com/books/…",
      "domain": "theguardian.com",
      "blocked": false,
      "start": 21,
      "length": 30
    }
  ]
}
```

Mention notifications gain `excerptLinks` and the mentions feed items gain `links`, both trimmed to the excerpt in the same way as the mentions.

New routes:

- `GET /l/:code` (public, at the root like `/r`): counts the tap and returns a 302 to the address. An unknown code gets a 404 page, and a blocked link gets a 410 "link removed" page. Responses are `no-store`, so a block takes effect on the next tap. Limited to 300 taps per 15 minutes per IP.
- `GET /admin/short-links/:code` and `PATCH /admin/short-links/:code` `{ blocked, reason? }` (admin bearer token): look up a link, and block or unblock it everywhere it appears.

Schema: migration `0082_short_links` adds the `short_links` table (code, url, created_by, click_count, blocked_at, blocked_reason). Both code and url are unique.

## Why

Clients asked for links in posts, comments and reviews. Sending every tap through our own redirect, rather than just making addresses clickable, gives us a kill switch: when an address turns out to be phishing or spam, it is blocked once and stops working in every post that carries it. Nobody has to find and edit the posts. Taps are also counted.

## Decisions

- **Tokens, like mentions.** Stored text holds `{{l:<id>}}`, and it is rendered to the short link on read. This uses the same pipeline mentions already go through on every write and read path, so no endpoint needed its own handling. The existing token-leak sweep (`mention-rendering.integration.test.ts`) now also fails on any raw `{{l:` and on any response that shows a short link without a links array.
- **Links are processed before mentions.** An address can contain an `@` (`medium.com/@ama/…`), and it must not be read as a mention.
- **One row per address, not per post.** The same address gets the same code wherever it is posted, so one block covers every copy. `created_by` is whoever posted it first.
- **Edits round-trip.** The app sends back the text it was shown. A short link of ours in that text maps back to the link it already is, so an unchanged resend is still not an edit, and nothing is marked "Edited". Our own short links are recognised even on a host without a dot, such as `localhost`, so this also works in development.
- **What counts as an address:** `http://`, `https://` or `www.` at a word boundary. Trailing punctuation is left out, and so is a closing bracket the address didn't open, but `Dune_(novel)` keeps its brackets. Only http(s) addresses with a dotted host and at most 2048 characters are linked. Addresses with a user name in them (`https://bank.com@evil.example`) are refused, because they disguise where they go. Bare domains (`example.com`) are not linked: too many false positives.
- **Caps.** At most 5 distinct links per text, and the rest stay plain text. Rows are stored for at most 10 addresses per text, so one comment cannot fill the table.
- **Unguessable codes.** Codes are 8 characters of Crockford base32 (about 10¹² values) behind the rate limit, so walking codes to find links in private posts is not practical. Codes are matched case-insensitively.
- **Blocked links** still render in the text, but with `blocked: true` and `target`/`domain` withheld.

## Out of scope

- **Existing text is not backfilled.** Addresses in posts written before this change stay plain text until the post is edited.
- No link previews (title/image unfurling), no "you're leaving Kinkané" interstitial, and no automatic Safe Browsing check when a link is posted. Blocking is manual through the admin route for now.
- No admin console screen yet; the admin routes are API-only.

## Verification

- Unit: `link-text.test.ts`, 25 cases covering detection, punctuation and brackets, scheme and host rules, the caps, hand-typed tokens, rendering, blocked links, the round trip, and mention offsets shifting correctly when links and mentions share a text.
- Integration, against a throwaway pgvector:pg18 database: `short-links.integration.test.ts` covers storing and rendering, an unchanged resend not counting as an edit, a real edit keeping the same link, de-duplication across a post and a comment, an `@` inside an address not becoming a mention, the 302 with its click count, the 410 after a block with the address hidden from the API, and the 404 for an unknown code. The extended token-leak sweep calls every signed-in GET with links seeded into every kind of text.
- Full unit suite (1496) and integration suite (16 files, 160 tests) pass.
