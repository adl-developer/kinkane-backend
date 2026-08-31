# Mobile Client Integration Checklists

Per-feature checklists for what the mobile app (a separate repo) needs to do to
integrate with this backend. Each section covers one feature end-to-end from
the mobile side — backend endpoints referenced here already exist unless noted.

## Push Notifications (Firebase Cloud Messaging)

Backend pieces already built: `device_tokens` table, `POST /user/device-tokens`,
`DELETE /user/device-tokens/:fcmToken`, and dispatch wired for friend requests
(sent/accepted), post comments, post likes, and new book recommendations.

1. **SDK setup** — add `@react-native-firebase/app` + `@react-native-firebase/messaging`
   (or the native FCM SDK), pointed at the same Firebase project as this
   backend's `FIREBASE_PROJECT_ID`. Drop in `google-services.json` (Android) /
   `GoogleService-Info.plist` (iOS).
2. **Permission request** — iOS requires an explicit `requestPermission()` call;
   Android 13+ requires the `POST_NOTIFICATIONS` runtime permission.
3. **Token registration** — on login and on `onTokenRefresh`, call
   `POST /api/v1/user/device-tokens` with `{ fcmToken, platform: 'ios' | 'android' }`.
4. **Token cleanup** — on logout, call `DELETE /api/v1/user/device-tokens/:fcmToken`.
5. **Foreground handling** — `messaging().onMessage()`. These are data+notification
   combo messages, so show an in-app toast/banner — FCM won't auto-display a
   system notification while the app is foregrounded.
6. **Background/quit handling** — `messaging().setBackgroundMessageHandler()`
   (Android) / native APNs handling (iOS). The system displays the notification
   automatically from the `notification` block; the app only needs to react to taps.
7. **Deep-link navigation** — on tap, read `data.type` and route accordingly:

   | `data.type` | Other `data` fields | Navigate to |
   |---|---|---|
   | `friend_request` | `senderId` | Sender's profile / friend requests screen |
   | `friend_request_accepted` | `accepterId` | Accepter's profile |
   | `post_comment` | `postId`, `commentId` | Post detail, scrolled to the comment |
   | `post_like` | `postId` | Post detail |
   | `new_recommendation` | `bookId` | Book detail |

8. **Notification preferences UI** — the Settings screen's toggles should map
   1:1 to the existing `notification_preferences` keys via
   `GET`/`PATCH /api/v1/user/notification-preferences`:
   `friendRequests`, `comments`, `likes`, `newBookSuggestions`
   (`rateReviewReminders` exists in the schema and toggle UI but has no
   dispatch behind it yet — deferred, see note below).

**Deferred / not yet built:** the "Finished reading? Remember to leave a
review" reminder has no backend trigger yet — it needs a new cron job and
eligibility query (books marked read/finished with no review after N days).
Its `rate-review-reminder` email template exists but nothing calls it. Push
for this event isn't wired either. No mobile work is blocked on this, but the
toggle in Settings currently controls a notification type that never fires.

## Swipe-Away Dislikes on the Recommendation List

Backend pieces already built: the `user_disliked_books` table, capture on both
onboarding and quiz-refresh, and filtering on every recommendation surface
(quiz results, personalized feed, "you may also like", recommendation emails).

**Nothing is recorded until the app sends these IDs.** The backend change is
additive and inert on its own — until the client wires this up, behaviour is
exactly as it was.

1. **Track swipe-aways on the recommendation list** — the screen where the user
   picks their 5 books. Collect the IDs of books they swipe away, the same way
   the chosen ones are collected. No other metadata is needed.
2. **Guest / first-time onboarding** — send them with the existing selections
   call: `POST /api/v1/guest-sessions/:id/selections` now takes
   `{ chosenBookIds, dislikedBookIds? }`. They're stored on the guest session
   and promoted to the user's permanent history at registration, so they start
   filtering from the user's very first feed.
3. **Every subsequent quiz** — send them on
   `PATCH /api/v1/recommendations/refresh` as `dislikedBookIds`.
4. **Send only the new ones.** Unlike every other field on `/refresh`, this is a
   delta: IDs are *added* to the user's permanent rejection history. Sending an
   empty array (or omitting it) clears nothing, and re-sending an ID the user
   already rejected is harmless — it counts as a repeat, not a duplicate.
5. **Reading them back** — `GET /api/v1/recommendations/preferences` returns
   `dislikedBookIds`, the full accumulated set. Use this if the UI ever needs to
   show or manage what the user has rejected.
6. **Send the access token on `GET /explore/trending`.** It's a public endpoint,
   but it filters out the viewer's rejected books when a token is present.
   Without one it returns the unfiltered global list.
   (`POST /recommendations` needs no token — it's the guest onboarding call,
   made before an account exists. A signed-in reader retaking the quiz goes
   through `PATCH /recommendations/refresh`, which applies their rejections.)
7. **What it affects** — a rejected book, *and other editions of it* (same title
   and author, different ISBN), stop appearing in quiz recommendations, the
   personalized home feed, trending, "you may also like" on book detail, and
   recommendation emails.
8. **What it does not affect** — search, browse, author pages and book detail.
   A rejected book is still reachable if the user goes looking for it; the
   rejection suppresses recommendations, not the catalogue.

## Social Sign-In (Firebase Auth SSO)

Full backend setup details (Firebase project creation, service account) are in
[`README.md` → Firebase Setup](../README.md#firebase-setup). This is the
mobile-side checklist only.

1. **SDK setup** — initialize Firebase in the mobile app against the same
   Firebase project as this backend's `FIREBASE_PROJECT_ID`, with the Google,
   Facebook, and/or Apple sign-in providers enabled in the Firebase console.
2. **Provider sign-in** — call the appropriate native sign-in flow per
   provider (Google Sign-In SDK, Facebook SDK, Sign in with Apple).
3. **Token exchange** — after a successful Firebase sign-in, call
   `firebaseUser.getIdToken()` and `POST` that ID token (not the raw
   provider access token) to `POST /api/v1/auth/social`.
4. **Guest-session carryover during onboarding** — if the user started the
   onboarding quiz before signing in, the `guestSessionId` must survive the
   OAuth redirect. Embed it in Firebase's `customParameters` state parameter
   before starting the provider sign-in, read it back from state in the OAuth
   callback, and include it in the `POST /auth/social` request body.
5. **Apple Sign-In is mandatory on iOS** if the app offers any other social
   login option (App Store guideline 4.8) — don't ship Google/Facebook sign-in
   on iOS without also offering Apple.
6. **Facebook extra step** — requires a Facebook App ID and secret registered
   in Firebase's Facebook provider settings (a backend/console-side
   configuration step, but the mobile app needs the matching Facebook App ID
   configured in its own Facebook SDK setup).
7. **Post-sign-in** — the mobile app uses the same JWT access/refresh token
   pair returned by `POST /auth/social` as email/password users from then on;
   no Firebase-specific auth handling is needed elsewhere in the app.

## Referral Links & the "Around the World" Competition

> **Changes since this section was written** — the invite funnel, the journey
> map and globe endpoints, the public analytics endpoint, and the move of
> referral crediting from signup to email verification are all covered in
> [mobile-referral-api-changes.md](mobile-referral-api-changes.md). Read that
> alongside this. The background below (deep links, carrying the code, why a
> dropped code is expensive) is still accurate.

Backend pieces already built: `referral_codes` / `referral_clicks` / `referrals`
/ `referral_points` tables, `GET /referrals/me`, `GET /referrals/me/stats`,
`POST /referrals/me/rotate`, `POST /referrals/invite`,
`GET /referrals/leaderboard`, `POST /referrals/clicks`,
`POST /guest-sessions/:id/referral`, and `referralCode` accepted on both
`POST /auth/signup` and `POST /auth/social`.

**Not built, and blocking:** the two domain-association files and the `/r/*`
rewrite, all of which live on `kinkane.app` rather than in either app repo. See
[referral-link-routing.md](referral-link-routing.md).

### The link

```
https://kinkane.app/r/K7M3QP9XVT/jason-appiatu?c=whatsapp
```

The code is the only meaningful part. The trailing name slug is decorative and
is never used to resolve anything, so **`/r/CODE` with no slug must work
identically** — chat clients sometimes clip the last path segment. `?c=` is the
share channel and should be passed through wherever the app forwards the code.

### 1. Register the link patterns

Handle both `/r/:code` and `/r/:code/:slug` on `kinkane.app`.

- **iOS** — Associated Domains entitlement `applinks:kinkane.app`, matching an
  `apple-app-site-association` file served from
  `https://kinkane.app/.well-known/apple-app-site-association` (JSON, **no file
  extension**, `Content-Type: application/json`, no redirects) with a path
  component matching `/r/*`.
- **Android** — an intent filter with `android:autoVerify="true"` for
  `https://kinkane.app/r/*`, matching
  `https://kinkane.app/.well-known/assetlinks.json` with the package name and the
  SHA-256 fingerprints of **every** signing certificate, release and upload.

Both files are served by the web team from the client domain. Neither app repo
can host them, and neither can this backend.

### 2. Report the tap — otherwise it is never counted

**This is the step most likely to be missed.** When the OS opens the app from a
universal/app link it does **not** make an HTTP request — the association file
was fetched at install time, so the path is matched locally and the URL handed
straight to the app. The backend never sees the tap.

So on launch from a referral link, call once:

```
POST /api/v1/referrals/clicks
{ "referralCode": "K7M3QP9XVT", "channel": "whatsapp" }
→ 202 { "ok": true }
```

No auth — the tap happens before there is an account. It always returns 202,
even for a code that doesn't exist, so don't treat the response as validation.

Call it **once per link open**, not on every cold start with a remembered code.
Repeat reports from the same device collapse anyway (clicks are deduplicated per
device), but the raw rows are still used for delivery debugging and shouldn't be
filled with noise.

Skipping this doesn't break attribution — signups still credit correctly — it
just makes `clicks` silently mean "people without the app", which gets worse as
installs grow.

### 3. Carry the code to signup

Two routes, depending on where the user is:

- **Straight to signup** — send `referralCode` (and optionally
  `referralChannel`) in the `POST /auth/signup` or `POST /auth/social` body.
- **Through onboarding first** — the usual path, since a fresh install starts
  with the quiz. Once a guest session exists, park the code on it:
  `POST /guest-sessions/:id/referral` with `{ "referralCode": "..." }`. Signup
  picks it up automatically, so `referralCode` in the signup body is then
  optional; if both are present the explicit one wins.

Hold the code until one of those succeeds. A code that never reaches signup is
not a lost point — it detaches that user from the referrer's tree permanently
(see step 5).

### 4. "Have an invite code?" on the signup screen

Prefill it when the code arrived by deep link, and leave it editable and
**visible** otherwise.

This is not a nicety. Tapping a link without the app installed sends the user to
the App Store, and the app then launches with no code — iOS does not carry it
across an install, and recovering it would need device fingerprinting, which
isn't worth the privacy cost. This field is the only recovery path for
share-to-install traffic, which is a large share of referrals.

### 5. Why a dropped code costs more than one referral

Attribution builds a tree. Someone who signs up without the code becomes a *root*
rather than a child, so:

- everyone they later refer is invisible to the original referrer, permanently;
- second-degree points (5/10) never reach the referrer at all;
- any "around the world" circuit that would have closed through that branch never
  fires, and nothing anywhere reports that it should have.

None of that surfaces as an error. It just quietly reads as a less successful
referrer.

### 6. Showing the user their standing

`GET /referrals/me` returns the link plus ready-made share strings — `whatsapp`,
`sms`, `email.mailto`, `copy` — each already carrying its own `?c=` tag. Use
them rather than composing the message in the app, so wording stays identical
across platforms and channels stay attributable. The `campaign` field says
whether the launch or evergreen copy is in force, for matching campaign artwork.

`GET /referrals/me/stats` returns `clicks`, `signups`, `sent`, `successful`,
`pending`, `countriesReached`, `points`, `pointsByKind`, `hasCircuit` and
`country`. The three funnel fields are new and **do not sum** — see
[mobile-referral-api-changes.md](mobile-referral-api-changes.md#these-three-do-not-add-up-do-not-fix-it).
Note `country` is resolved
once at signup and frozen; a user showing `null` there **scores nothing**, so a
null is worth surfacing to support rather than hiding.

## The web shop features you now integrate with

The web eCommerce designs came with a set of things the server had never
supported. All the customer-facing ones now exist, and the mobile client has to
adopt each of them explicitly or your users will see stale UI compared to the
web. Backend audit and rationale live in [design-gaps-plan.md](./design-gaps-plan.md);
the client contract is in [shop-integration.md](./shop-integration.md); the
authoritative field-by-field spec is `GET /openapi.json` (Swagger UI on the
same host at `/docs`).

### Delivery phone number at checkout, and on the profile

The web checkout collects one and the account screen shows it. Add both to the
mobile flows.

**At checkout.** `POST /api/v1/cart/checkout` now takes `contactPhone`.

- Ask for it in **international format** — the field label the web uses is
  "Phone Number" with placeholder `+233 20 123 4567`.
- Spaces, dashes and brackets are fine and get stripped server-side. `00…` is
  accepted and converted to `+…` — both are how people type an international
  number.
- A bare national number (`020 123 4567`) is **rejected**. The server does
  not guess the country code from the shipping address, because a plausible
  wrong number costs a delivery.
- `contactPhone` is honoured for signed-in buyers as well as guests, unlike
  `contactEmail`: someone shipping a gift can enter the recipient's number
  without editing their own profile. A signed-in buyer who sends nothing falls
  back to the number on their profile.

**On the profile.** `PATCH /api/v1/user/settings/profile` now accepts `phone`
alongside `name` and `photoUrl`. Send `null` to clear it. `GET /api/v1/auth/me`
returns it under `user.phone`.

**On order history and detail.** `contactPhone` is a new field on every order
returned by `GET /api/v1/orders` and `GET /api/v1/orders/:id`. It is a snapshot
— changing the profile number later does not retroactively change what is on a
parcel that already shipped.

### Order confirmation email

When payment lands, the buyer now gets a confirmation email: order number, the
books, the totals (including the discount), and where it is going.

**For guest orders it also carries the tracking code.** That code is handed to
your client exactly once, in the checkout response — before this email existed,
a guest who closed the tab lost access to their own paid order permanently.

Two things this does not change for you:

- **Still store the `accessToken` client-side at checkout.** The email is a
  safety net: it is slower than the confirmation screen, and sometimes never
  arrives.
- **It is not a payment receipt.** Stripe issues those. This one answers what a
  receipt does not — what was bought, where it is going, and how to find it
  again.

### The 15% first-order discount

Automatic on every buyer's first paid order. **No code field, and no basket
line** — the reduction is applied at checkout and appears only there.

Do not build a promo code UI. The cart and price endpoints deliberately never
ask for an email, because eligibility depends on one, and turning the basket
into an oracle for "has this address ordered here before" would be a data leak
on any address anyone can type.

The checkout response now carries:

```
discountMinor: 1117
discountReason: "first_order"   // null when nothing applied
totalMinor: 6331                // discount already applied
```

If `discountMinor > 0`, **the confirmation UI needs a discount line the current
designs do not have.** The reconciliation always holds:

```
subtotalMinor - discountMinor + shippingMinor + taxMinor === totalMinor
```

Same fields exist on every order returned by `GET /api/v1/orders` and
`GET /api/v1/orders/:id`, so the order-history and order-detail screens can
render the discount too.

Three things worth internalising:

- **Shipping is quoted on the pre-discount basket.** A promotion cannot push
  a basket below a free-shipping threshold and cost the buyer delivery.
- **Tax is on the discounted amount** — that is what was actually paid.
- **The discount can be withheld on a second attempt, and that is not an
  error.** Only one live discounted order per customer is allowed at a time, so
  if a checkout is started twice — a double-tap, a retry after a dropped
  connection, two devices — the second comes back with `discountMinor: 0` and a
  higher total. Read `discountMinor` and `totalMinor` **from the response you
  are about to send the user to Stripe with**, every time. Never carry a total
  forward from an earlier attempt or from the basket, or the amount on screen
  will not match the amount Stripe charges.

  Abandoning a checkout does *not* burn the promotion: once the old attempt
  expires, the discount is available again.

### Prices on shop listings — read `unitPriceMinor`, not `prices`

**This is the single most important change for the mobile shop, and it is a
correction to what the app is most likely doing today.**

Every book in a `shoppable=true` response now carries the live sellable price:

```jsonc
{
  "id": 48213,
  "title": "Wandering Stars",
  "unitPriceMinor": 2899,     // what the shop charges, in `currency`
  "compareAtMinor": null,     // pre-markdown price when on sale; null otherwise
  "currency": "USD",
  "inStock": true,
  "prices": [ … ]             // ONIX metadata — DO NOT render this on a shop screen
}
```

**Stop rendering the `prices` array on any shop surface.** It is ONIX edition
metadata: it is GBP-only, and it disagrees with the live supplier feed on about
one book in fifty. A listing built from it will occasionally advertise a price
the basket then refuses to honour — the customer sees one number on the shelf
and a different one in their cart, which reads as a bug even though nothing is
broken.

`unitPriceMinor` is the same number `POST /cart/price` will quote and the same
number `priceMin`/`priceMax` filter on.

Three rules:

- **Render `compareAtMinor` struck through** when it is non-null. That is a live
  markdown, and it is the only sale signal on a listing.
- **Do not cache these.** Supplier prices move hourly. Re-fetch when a screen is
  shown; never persist a price and re-display it later.
- **Both fields are absent without `shoppable=true`**, along with `inStock`. A
  discovery screen that renders an Add button must pass the flag.

**The discovery feeds carry these too.** `GET /explore/trending`,
`GET /explore/personalized`, `GET /books/:id/similar` and
`GET /books/recommendations` all return `unitPriceMinor`, `compareAtMinor`,
`currency` and `inStock` when passed `shoppable=true` — so a carousel with an
Add button needs no second request.

Those feeds are cached server-side, but **the price is not**: the cached pool
holds books only, and the live price is attached on every request. A supplier
price change shows up immediately even while the feed itself is still cached.
Treat the price as fresh and the ordering as up to an hour old.

### Shop filters on `GET /books`

The web filter panel gained four things `?shoppable=true` had never supported:

| Param | Notes |
| --- | --- |
| `isbn` | Exact ISBN-13. Hyphens and spaces are stripped, so the number as printed on the book works. |
| `yearMin` / `yearMax` | Publication year, inclusive. Undated books drop out of a year-filtered result. |
| `priceMin` / `priceMax` | In **major units** of `currency`: `20` means $20, not 2000 cents. |
| `currency` | Which currency the price bounds are in. Defaults to the currency this request would be quoted in. |
| `sortBy` | `title` or `newest`. Pair with `sort=asc\|desc`. |

Three things to know before wiring this up:

- **Price bounds require `shoppable=true`.** Sending them without the flag is
  a 400, not a page that came back unfiltered — the price lives on the
  supplier row that only the shoppable path consults.
- **`sortBy` is ignored when `q` is present.** Search results are ranked by
  relevance; sort would give you neither ranking. If your filter panel offers
  both a search box and a sort, expect the sort to have no effect while a
  query is present.
- **There is no `price` sort.** Measured; the query shape needs a partial
  index. See `design-gaps-plan.md` for what shipping it needs.

### Announcement banners on the storefront

`GET /api/v1/settings/banners` returns the strips at the top of every web
page. Public, unauthenticated, controlled from the admin console.

```
{
  "banners": [
    { "slot": "top",    "text": "We Ship Worldwide!" },
    { "slot": "second", "text": "15% Off Your First Order" }
  ]
}
```

- **`slot: 'top'`** is the red strip. **`slot: 'second'`** is the charcoal one
  beneath it. Render in that order.
- Only enabled banners come back. An empty array means show neither.
- **Do not cache the response for more than a minute or two.** The admin
  console change is meant to be live.
- **Do not tie the banner text to the discount rate.** The banner is copy the
  operator edits; the discount rate is a separate config value. Turning one
  off does not switch the other off, and the mobile app should render whatever
  text comes back rather than deriving it from anything.

### Contact Us form

`POST /api/v1/contact` — public, optional auth. Send it whenever the user is
signed in and you have a token, so support can see who they are talking to.

```
{
  "name": "Ama Boateng",
  "email": "ama@example.com",
  "subject": "Where is my order?",
  "message": "…",
  "website": ""                // honeypot — leave empty, hide from users
}
```

Response is always `201 { "received": true }` when the payload is well-formed,
including when the honeypot was filled. **Rate limited to 3 an hour per IP.** A
`429` with the usual `Retry-After` is worth surfacing gently in the UI rather
than hidden as a generic error, because it is what someone hitting the button
repeatedly after a network glitch will see.

### Blacklist state (already handled — worth knowing about)

An admin can now block an account. From the mobile app's side there is nothing
new to build, but two responses now exist that did not before:

- **`POST /api/v1/auth/login`** returns `403 { "error": "This account has been
  suspended. Contact support.", "code": "ACCOUNT_SUSPENDED" }` for a
  blacklisted account. Show it as-is; do not treat it as a wrong-password
  error, because the customer will keep resetting a password that works and
  never get in.
- **`POST /api/v1/auth/refresh`** returns `401` for a blacklisted account, and
  their refresh tokens are deleted the moment the block is applied. **This is
  the one most likely to surprise you:** a blacklist can land mid-session, so
  handle a failed refresh as "signed out" rather than retrying it. The app will
  otherwise sit in a refresh loop that can never succeed.
- **`POST /api/v1/auth/social`** returns the same `403`. Social sign-in is not
  a way around a block.
- **`POST /api/v1/cart/checkout`** returns the same 403 for a signed-in buyer
  whose account was blocked after login but before checkout. Sign the user out
  when you see it.

### What did NOT change and is not coming for you

- **Product reviews.** The web PDP has a Reviews tab, but its source is an
  open product decision (editorial press quotes vs reader reviews). No new
  endpoint exists. Do not build a Reviews tab yet.
- **Order actions in the app.** The admin console is web-only. Nothing in the
  customer API changed here.

## Rollout checklist for the mobile app

For each of the sections above, in order:

1. **Prices on shop listings** — switch every shop screen from the `prices`
   array to `unitPriceMinor`/`currency`, strike through `compareAtMinor` when
   it is non-null, and stop persisting any price. **Do this first:** it is the
   only item on this list that corrects something already on screen, and until
   it is done a shopper can see one price on the shelf and another in the cart.
2. **Phone number** — add the input to checkout, add the display + edit to
   Profile, thread it through `GET /users/me`, keep the profile fallback
   invisible to the user.
3. **First-order discount** — render a discount line on the checkout summary
   and on the order confirmation/detail screens whenever `discountMinor > 0`.
   Do not read `discountMinor` from the basket, because it is not there — and
   re-read it from every checkout response rather than carrying one forward.
4. **Filters** — extend the shop filter panel; refuse to enable the price
   bounds unless the user is on a shoppable listing.
5. **Announcement banners** — render both slots at the top of every shop
   screen; fetch on foreground, cache for at most a minute or two.
6. **Contact Us** — add the screen; include the honeypot; handle 429 as
   "please wait" rather than a generic failure.
7. **Suspended accounts** — special-case `ACCOUNT_SUSPENDED` at login, social
   sign-in and checkout with the server-provided message, and treat a failed
   `POST /auth/refresh` as signed-out rather than retrying it.
