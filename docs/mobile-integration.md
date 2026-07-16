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
