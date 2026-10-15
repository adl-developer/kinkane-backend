# Short links on www.kinkane.app/s/

## What changed

Short links in posts, comments, reviews and other user text can now be shown on the website's own domain, as `https://www.kinkane.app/s/<CODE>`. Before this, they could only be shown as `APP_URL/l/<CODE>`, a path that only the API server answers. That address 404s in production, because `kinkane.app` is the web client.

- **New setting `SHORT_LINK_URL`.** This is the prefix every short link is shown under. In production it is `https://www.kinkane.app/s`. When it is unset, links fall back to `APP_URL/l`, which is the previous behaviour and suits local development.
- **New route `GET /s/:code`.** It behaves exactly like `/l/:code`: it counts the tap and returns a 302 to the address, a 410 page for a blocked link, or a 404 page for an unknown code. `/l/:code` stays, so any link already shared in that form keeps working.
- **Edits accept both forms.** A short link sent back in either form maps to the link it already is: `/s/<CODE>` or `/l/<CODE>`, on the short-link host or `APP_URL`, with or without `www.`. An edit of an older post therefore doesn't create new links and isn't marked "Edited".

## Why

The web client is hosted on Vercel and the API on Render. Paths like `/r/` and `/redirect/` already reach the API because the web project forwards them, and short links need the same. A letter before the code (`/s/`) is needed because the domain is shared with the website: a bare `www.kinkane.app/<CODE>` would collide with real pages such as `/books`. LinkedIn can drop the prefix only because `lnkd.in` serves nothing else.

## Going live, in order

1. Deploy the API with this change.
2. Add the rewrite `/s/:code` → `https://kinkane-server.onrender.com/s/:code` to the web project, next to the `/r/` one. See `docs/referral-link-routing.md`.
3. Set `SHORT_LINK_URL=https://www.kinkane.app/s` on Render.

Stored text holds link tokens, not addresses. So step 3 switches every existing post to the `/s/` form at once, with no data migration. Before step 3, nothing changes.

## Out of scope

- The prefix is still shown with `https://` in the text, so copy-paste and other apps recognise it as a link.
- No separate short domain.

## Verification

- Unit (`link-text.test.ts`, 27 cases): `/s/` and `/l/` are both recognised, `www.` and the bare domain count as the same site, and lookalike hosts (`kinkane.app.evil.example`), other paths, query strings and an empty host list are refused. Links render under the configured prefix.
- Integration (`short-links.integration.test.ts`, with `SHORT_LINK_URL` set): links render as `https://www.kinkane.app/s/<CODE>`. Re-sending a post with a link in the old `APP_URL/l/` form leaves it unchanged and not edited. Both `/s/` and `/l/` redirect and count taps, and blocking still works.
- Full unit and integration suites pass.
