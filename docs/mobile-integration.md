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
{ "code": "K7M3QP9XVT", "channel": "whatsapp" }
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

`GET /referrals/me/stats` returns `clicks`, `signups`, `countriesReached`,
`points`, `pointsByKind`, `hasCircuit` and `country`. Note `country` is resolved
once at signup and frozen; a user showing `null` there **scores nothing**, so a
null is worth surfacing to support rather than hiding.
