# App links move under /redirect

## What changed

Every link this server sends that should open the mobile app is now built as
`https://kinkane.app/redirect/<path>` instead of `https://kinkane.app/<path>`.
That covers referral links, the links in the welcome, follow-request,
weekly-digest, trial-ending, subscription and new-recommendation emails, the
password-reset and email-change links, and the `upgradeUrl` on 402 responses.
Stripe return URLs keep their plain paths.

A new public route, `GET /redirect/*`, handles the same links when they are
opened in a browser rather than the app: it answers `302` to the same path
without the prefix, keeping the query string. `/redirect/r/*` goes to the
existing referral handler, so a click from a browser is still counted.

## Why

The iOS and Android association files have to list every path that should
open the app. With links spread across a dozen paths, adding a new email meant
remembering to update those files on the web host too — and forgetting fails
silently, with the link opening the web page instead. One prefix means the
association files register `/redirect/*` once.

## Decisions

- **Path prefix, not a `?to=` parameter.** Token links and referral links
  already carry query strings; nesting them inside an encoded parameter is
  harder to read and easy to double-encode.
- **The forward builds its target by setting path and query on `APP_URL`,**
  never by resolving the incoming string. `/redirect//evil.com` would otherwise
  resolve to a protocol-relative URL and make this an open redirect.
- **`Cache-Control: no-store` on the forward,** because reset and email-change
  links carry single-use tokens.
- **`/invite` stays unprefixed.** It is only ever a redirect target for a
  browser that didn't open the app, never a link sent to anyone.
- **Unsubscribe, privacy and terms links are unchanged.** They must keep
  working for people who have deleted the app.

## Not in scope

- **Association files and the web-host proxy.** Both live on the client domain.
  The web host must proxy `/redirect/*` (alongside the existing `/r/*`) to this
  API — see `docs/referral-link-routing.md`.
- **Old links.** Links already sent have no prefix. The association files should
  keep the old paths registered for now; `docs/deep-links.md` lists them.
- **Stripe return URLs.** Checkout returns keep their unprefixed paths
  (`/account/subscription?checkout=...`, `/cart?checkout=...`).

## Verification

Unit tests in `src/__tests__/app-link-redirect.test.ts` cover the prefix, the
forward (path, query string, bare prefix), the open-redirect guard and the
no-store header. The full unit suite passes.
