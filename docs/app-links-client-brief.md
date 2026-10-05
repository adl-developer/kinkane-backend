# App links under `/redirect` — client brief

**Audience:** the iOS, Android and web teams.
**Status:** on branch `feat/app-links-redirect-prefix` in `kinkane-backend`, not
yet merged. **Nothing below should ship to production before the web proxy in
§4 is live** — see §7 for the order.

This document is self-contained. The backend's running reference is
[deep-links.md](deep-links.md). Where the two disagree, `deep-links.md` is
correct.

---

## 1. What changed, in one paragraph

Every link the backend sends that should open the app now starts with
`https://kinkane.app/redirect/`. That covers links in emails, push notifications
and referral shares. The association files register **one** pattern,
`/redirect/*`, instead of a list of paths that had to change every time a new
email was added. With the app installed, the OS opens the app. Without it, the
link goes to the API, which forwards the browser to the same page without the
prefix, so the link still works on the web.

Stripe checkout returns are the exception. They keep their plain paths (§3).

---

## 2. The links

### 2.1 App links (sent with `/redirect`)

| Link | Sent from | App should open |
| --- | --- | --- |
| `/redirect` | welcome, follow-request and weekly-digest emails | home tab |
| `/redirect/r/:code` | referral links with the name clipped off by a chat app | referral handling (§5) |
| `/redirect/r/:code/:slug?c=CHANNEL` | referral share sheets, referral invite emails | referral handling (§5) |
| `/redirect/books/:bookId` | new-recommendation email and push | book detail |
| `/redirect/explore` | subscription-confirmed email | Explore |
| `/redirect/subscribe` | trial-ending email | paywall / upgrade |
| `/redirect/account/subscription` | payment-failed and cancellation emails; `upgradeUrl` on any 402 response | subscription management |
| `/redirect/reset-password?token=TOKEN` | password-reset email | set-new-password screen |
| `/redirect/cancel-email-change?token=TOKEN` | email-change notice to the old address | cancel-email-change confirmation |

The referral slug is decorative. It carries the referrer's name and is never used
to look anything up, so `/redirect/r/CODE` with no slug must behave exactly the
same as `/redirect/r/CODE/jason-appiatu`.

### 2.2 Stripe checkout returns (no prefix)

| Link | When |
| --- | --- |
| `/account/subscription?checkout=success` | subscription checkout completed |
| `/account/subscription?checkout=cancelled` | subscription checkout abandoned |
| `/cart?checkout=success&orderId=N` | book order paid |
| `/cart?checkout=cancelled&orderId=N` | book order abandoned |

These open the app only because `/account/subscription` and `/cart` stay in the
association files (§3). Don't remove them.

### 2.3 Never open the app

| Path | Why |
| --- | --- |
| `/unsubscribe?token=TOKEN` | must work for someone who has deleted the app, usually from a webmail browser |
| `/privacy`, `/terms` | email footer links, read by people who aren't users |
| `/about` | public marketing page, the default referral video link |

None of these is ever sent with `/redirect`. On iOS, list them as exclusions
anyway (§3.1), in case someone adds a wildcard later.

---

## 3. Association files — web team hosts, app teams supply IDs

Both files are served from `kinkane.app`. Neither app repo nor the backend can
host them.

Alongside `/redirect/*`, keep the **old unprefixed paths** registered.
Emails and referral links sent before this change are still out there. Referral
links in particular sit in chat histories for good. Everything marked *legacy*
below can come out later, **except** `/account/subscription` and `/cart`, which
the Stripe returns still use.

### 3.1 iOS — `https://kinkane.app/.well-known/apple-app-site-association`

Served as JSON, **no file extension**, `Content-Type: application/json`, over
HTTPS, with **no redirects**. The app needs the Associated Domains entitlement
`applinks:kinkane.app`.

Replace `TEAMID.app.bundle.id` with the real value. iOS checks the patterns in
order and the first match wins, so the exclusions go first.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.app.bundle.id"],
        "components": [
          { "/": "/unsubscribe*", "exclude": true },
          { "/": "/privacy*", "exclude": true },
          { "/": "/terms*", "exclude": true },
          { "/": "/about*", "exclude": true },

          { "/": "/redirect" },
          { "/": "/redirect/*" },

          { "/": "/account/subscription" },
          { "/": "/cart" },

          { "/": "/", "comment": "legacy" },
          { "/": "/r/*", "comment": "legacy" },
          { "/": "/invite", "comment": "legacy" },
          { "/": "/books/*", "comment": "legacy" },
          { "/": "/explore", "comment": "legacy" },
          { "/": "/subscribe", "comment": "legacy" },
          { "/": "/orders", "comment": "legacy" },
          { "/": "/reset-password", "comment": "legacy" },
          { "/": "/cancel-email-change", "comment": "legacy" }
        ]
      }
    ]
  }
}
```

`"/"` matches the path only. Query strings (`?token=`, `?checkout=`) don't
affect matching and still reach the app.

### 3.2 Android — intent filter + `https://kinkane.app/.well-known/assetlinks.json`

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="kinkane.app" />

  <data android:pathPrefix="/redirect" />
  <data android:path="/account/subscription" />
  <data android:path="/cart" />

  <!-- legacy -->
  <data android:path="/" />
  <data android:pathPrefix="/r/" />
  <data android:path="/invite" />
  <data android:pathPrefix="/books/" />
  <data android:path="/explore" />
  <data android:path="/subscribe" />
  <data android:path="/orders" />
  <data android:path="/reset-password" />
  <data android:path="/cancel-email-change" />
</intent-filter>
```

Android has no exclusions. The excluded paths in §2.3 are left out because they
aren't listed. Don't replace this list with a catch-all.

`assetlinks.json` must list the package name and the SHA-256 fingerprints of
**every** signing certificate: the Play App Signing key and the upload key.

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "app.package.name",
      "sha256_cert_fingerprints": ["AA:BB:…", "CC:DD:…"]
    }
  }
]
```

---

## 4. Web host — proxy `/redirect/*` to the API

`/redirect/*` is handled by the API server, not the web app. The web host must
**proxy** (not redirect) it, the same way `/r/*` should already be proxied:

```js
// next.config.js
module.exports = {
  async rewrites() {
    return [
      { source: '/redirect/:path*', destination: 'https://kinkane-server.onrender.com/redirect/:path*' },
      { source: '/r/:path*',        destination: 'https://kinkane-server.onrender.com/r/:path*' },
    ];
  },
};
```

Vercel (`vercel.json`) and Netlify (`_redirects`) versions are in
[referral-link-routing.md](referral-link-routing.md).

What the API does with it:

- `/redirect/r/...` records the referral click and sends the browser (302) to
  `/invite?ref=CODE&c=CHANNEL&cid=CLICKID`.
- Any other `/redirect/<path>` sends the browser (302) to `/<path>`, query string
  intact. For example, `/redirect/books/42` → `/books/42`.

So **the web app must still serve every plain page** (`/`, `/books/:id`,
`/explore`, `/subscribe`, `/account/subscription`, `/reset-password`,
`/cancel-email-change`, `/invite`). The prefix only changes the URL that gets
sent, not the page the reader lands on.

Don't cache either path at the CDN. Referral redirects write a click row, and the
reset and email-change forwards carry single-use tokens. The API sends
`Cache-Control: no-store` on the forward. If your host applies a blanket cache
policy to proxied paths, exclude these two.

---

## 5. App routing

### 5.1 The rule

1. If the path starts with `/redirect`, remove that prefix. An empty result means
   `/`.
2. Route on what's left, **with its query string**, using the table in §2.1. The
   legacy paths and the Stripe returns route the same way, since they're already
   in their stripped form.
3. For anything unrecognised, open the home tab. Don't show an error screen: an
   unknown path is most likely a newer link than this version of the app knows.

```
/redirect/books/42                    → /books/42
/redirect/reset-password?token=abc    → /reset-password?token=abc
/redirect                             → /
/cart?checkout=success&orderId=91     → /cart?checkout=success&orderId=91  (unchanged)
```

### 5.2 Keep the query string

This is the easiest thing to get wrong.

- **Stripe returns.** `?checkout=success` and `orderId` are the only signal the
  app gets that a payment went through. The account itself is updated by
  Stripe's webhook on the server. The return URL is what tells the screen to
  stop showing a spinner and refresh. If a handler matches `/cart` and drops the
  query, the user is stuck on a screen that never finishes loading.
- **Tokens.** `/reset-password` and `/cancel-email-change` are useless without
  `?token=`. The tokens are single-use and short-lived (the email-change one
  lasts 15 minutes). Send the token to the API once; don't store it or retry it
  on a later launch.

### 5.3 Referrals: report the tap yourself

When the OS opens the app from a link, **no HTTP request is made**, so the
server never sees the tap. On launch from `/redirect/r/...` (or legacy `/r/...`),
call once:

```
POST /api/v1/referrals/clicks
{ "referralCode": "K7M3QP9XVT", "channel": "whatsapp" }
→ 202 { "ok": true }
```

This call needs no auth. It always returns 202, even for an unknown code, so
don't treat the response as a check that the code is valid. Call it once per
link opened, not on every launch that remembers a code.

Then hold on to the code until signup: attach it to the guest session with
`POST /api/v1/guest-sessions/:id/referral`, and prefill (editable) the "Have an
invite code?" field. Both are described in
[mobile-integration.md](mobile-integration.md).

---

## 6. Testing

**Association files are live and valid:**

```bash
curl -sI https://kinkane.app/.well-known/apple-app-site-association
```

```bash
curl -s https://kinkane.app/.well-known/assetlinks.json
```

Expect `200`, `application/json`, and no `301`/`302` on either.

**Web fallback works:**

```bash
curl -sI https://kinkane.app/redirect/books/1
```

Expect `302` with `Location: https://kinkane.app/books/1`. A `404` means the
proxy in §4 isn't in place.

**The app opens:**

- iOS gets the association file through Apple's CDN, which can take a day to
  pick up a change. During development, add `?mode=developer` to the
  entitlement (`applinks:kinkane.app?mode=developer`) and turn on Associated
  Domains Development in the developer settings on the device, so the file is
  fetched directly.
- Android: `adb shell pm verify-app-links --re-verify <package>`, then
  `adb shell pm get-app-links <package>`. `kinkane.app` should show `verified`.
- Tap links from Notes, Messages or Mail. Typing a link into Safari's address bar,
  or following a link from a page already on `kinkane.app`, opens the web page by
  design, and that isn't a bug.

**Go through each row** of §2.1 and §2.2 with the app installed and without it.
The row passes if you land on the right screen with the query string's effect
visible: payment spinner resolves, reset form accepts the token.

---

## 7. Rollout order

As soon as the backend change deploys, every new email and share uses `/redirect`.
Until the web proxy exists, those links **404 in a browser**. So:

1. **Web:** add the `/redirect/*` proxy (§4) and deploy.
2. **Backend:** merge and deploy `feat/app-links-redirect-prefix`.
3. **Web:** update both association files (§3) at any point after step 1.
4. **Apps:** release the routing change (§5).

The old links keep working through all four steps, because the legacy patterns
stay registered and the plain web pages are unchanged. After step 3, a `/redirect`
link opened on a phone with an older app version opens the app with a URL it
doesn't recognise. The home-tab fallback in §5.1 is what keeps that from being a
dead end, so if the current apps don't already have that fallback, it's worth
shipping in step 4 before step 3.
