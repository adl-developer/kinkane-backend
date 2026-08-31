# Kinkané referral feature — complete mobile integration brief

**Audience:** whoever (human or agent) is implementing the referral pieces in
the Kinkané mobile app, which lives in a repo separate from the backend.

**This document is self-contained.** Everything needed is below — endpoint
specs, request and response shapes, the deep-link setup, the failure modes, and
the open questions. No other file is required.

---

## 1. Scope — what the app is responsible for

Checked against the *Kinkane App — Production MVP 1* Figma file. The app's
referral surface is **one card on the Profile screen**, plus deep-link handling
and passing a code through signup. That's it.

From the Profile screen design:

> **Refer a Friend**
> Share your link and earn 1 point for each friend who creates and verifies their account.
> `kinkane.app/ref/elisabeth-g`   [Copy]
> [SMS] [WhatsApp] [Email]
> You have earned 3 points from referrals
> Track the journey — Around the World in 80 Days →

Every element maps to two GETs and one POST:

| Element | Source |
| --- | --- |
| The link | `link` from `GET /referrals/me` |
| Copy / SMS / WhatsApp / Email | `copy`, `sms`, `whatsapp`, `email.mailto` from the same call |
| "You have earned 3 points" | `points` from `GET /referrals/me/stats` |
| Each share tap | `POST /referrals/shares` |
| "Track the journey →" | Opens the web campaign page in a browser. No app endpoint. |

**Not the app's problem.** The journey map, the interactive globe, the analytics
dashboard and the public leaderboard are web-only screens. Backend endpoints
exist for them (`/referrals/me/network`, `/referrals/analytics`,
`/referrals/map`, `/referrals/leaderboard`) and are documented elsewhere. The app
links out to that experience rather than rendering it, and should not call them.

---

## 2. Three things in the design that will not work as drawn

Raise all three before building. Two are copy problems; one is blocking.

### 2.1 `kinkane.app/ref/elisabeth-g` is not a real link

Two problems. The path is `/r/`, not `/ref/`. More importantly, there is **no
referral code in it** — a name slug alone cannot resolve to a user, because
names are not unique and a guessable link would be an enumerable one, which
would expose the user list.

The real link looks like this, and comes back ready-made from the API:

```
https://kinkane.app/r/K7M3QP9XVT/elisabeth-green?c=whatsapp
```

**Render `link` from `GET /referrals/me` verbatim.** Do not construct it in the
app, and do not display a shortened or prettified version — the string the user
copies must be the string that resolves. The trailing name slug is decorative
(`/r/CODE` on its own works identically), but the code is mandatory.

If display width is the concern, that is a design conversation, not something to
solve by trimming the code out.

### 2.2 "earn 1 point for each friend" understates the scoring

Points depend on geography, not headcount:

| What happened | Points |
| --- | --- |
| Friend in your own country | 1 |
| Different country, same continent | 10 |
| Different continent | 20 |
| Friend-of-a-friend, same continent as you | 5 |
| Friend-of-a-friend, different continent | 10 |
| A chain reaching two continents outside yours and returning home | 30 |

Geography is measured from **the person earning the points**, not from whoever
is in the middle. Nothing at all is paid beyond one person removed. "1 point per
friend" is therefore the *minimum* case, and the copy will read as broken to
anyone who refers someone abroad and sees +20.

### 2.3 There is no email-verification screen in the app design — and points now depend on one

**This is blocking.** The card's own copy says "creates **and verifies** their
account", which is correct: referral points are now awarded at email
verification, not at signup. But the app's signup flow in Figma runs Full name →
Email address → Password → Create account, with no OTP screen anywhere in the
file.

If a user has no way to enter their verification code, **every referral from an
email/password signup stays uncredited forever**, and the card reads "0 points"
no matter how many friends join. `POST /auth/verify-email` and
`POST /auth/resend-verification-email` both exist and are ready (specs in §5.6
and §5.7); what is missing is the screen.

---

## 3. The behaviour change: points are earned at verification

Previously, creating an account with a referral code credited the referrer
immediately. Now the referral is recorded at signup but sits uncredited until
the new user verifies their email address.

| Signup path | When the referrer is credited |
| --- | --- |
| Email + password (`POST /auth/signup`) | When the user posts their OTP to `POST /auth/verify-email` |
| Google / social (`POST /auth/social`), new account | Immediately — Google has already verified the address |
| Google / social, linking to an existing unverified account | Immediately, on the linking sign-in |

That third row matters for a flow the app can produce easily: someone signs up
with email and password, never enters the OTP, then later taps "Continue with
Google" with the same address. Linking a Google account now **marks the account
verified and credits the waiting referral**, because signing in through Google
proves ownership of the same address the OTP existed to prove. The app does not
need to do anything to trigger it, but it does mean a user can become verified
without ever seeing an OTP screen — so don't assume `emailVerified` only ever
flips via `POST /auth/verify-email`.

Crediting happens server-side and asynchronously. The app calls nothing to
trigger it, and re-verifying cannot double-pay.

**When testing:** sign up a test user with a referral code, then check the
referrer's `points`. It will not move until that test user verifies. This is
correct behaviour and it is the single most likely thing to send someone
debugging in the wrong direction.

---

## 4. Deep links — receiving a referral

### 4.1 The link

```
https://kinkane.app/r/K7M3QP9XVT/elisabeth-green?c=whatsapp
```

The code is the only meaningful part. The trailing name slug is decorative and
is never used to resolve anything, so **`/r/CODE` with no slug must work
identically** — chat clients sometimes clip the last path segment. `?c=` is the
share channel and should be passed through wherever the app forwards the code.

### 4.2 Register the link patterns

Handle both `/r/:code` and `/r/:code/:slug` on `kinkane.app`.

- **iOS** — Associated Domains entitlement `applinks:kinkane.app`, matching an
  `apple-app-site-association` file served from
  `https://kinkane.app/.well-known/apple-app-site-association` (JSON, **no file
  extension**, `Content-Type: application/json`, no redirects) with a path
  component matching `/r/*`.
- **Android** — an intent filter with `android:autoVerify="true"` for
  `https://kinkane.app/r/*`, matching
  `https://kinkane.app/.well-known/assetlinks.json` containing the package name
  and the SHA-256 fingerprints of **every** signing certificate, release and
  upload.

Both association files are served by the web team from the client domain.
Neither app repo can host them, and neither can the backend.

### 4.3 A backend-adjacent blocker you should know about

Referral links point at `kinkane.app`, but the handler that resolves the code,
records the click and issues the redirect lives on the **API server**, deployed
separately. The web team must proxy `/r/*` from `kinkane.app` to the API host —
a rewrite, not a redirect, and excluded from any CDN caching (the endpoint has a
side effect).

**As of this writing that proxy is not applied.** Until it is, taps that go
through the web (rather than opening the app directly) record nothing. Signups
still attribute correctly, so the symptom is a `clicks` figure stuck at 0 while
signups climb — which reads like a broken counter rather than a routing problem.
Not an app-side fix, but it will affect what you see while testing.

### 4.4 Report the tap — otherwise it is never counted

**The step most likely to be missed.** When the OS opens the app from a
universal/app link it does **not** make an HTTP request. The association file was
fetched at install time, so the path is matched locally and the URL handed
straight to the app. The backend never sees the tap.

So on launch from a referral link, call `POST /api/v1/referrals/clicks` once
(spec in §5.4).

Call it **once per link open**, not on every cold start with a remembered code.
Repeat reports from the same device collapse anyway, but the raw rows are used
for delivery debugging and shouldn't be filled with noise.

Skipping this doesn't break attribution — signups still credit correctly — it
just makes `clicks` silently mean "people without the app", which gets worse as
installs grow.

### 4.5 Carry the code to signup

Two routes, depending on where the user is:

- **Straight to signup** — send `referralCode` (and optionally `referralChannel`)
  in the `POST /auth/signup` or `POST /auth/social` body.
- **Through onboarding first** — the usual path, since a fresh install starts
  with the quiz. Once a guest session exists, park the code on it with
  `POST /guest-sessions/:id/referral`. Signup then picks it up automatically, so
  `referralCode` in the signup body becomes optional; if both are present, the
  explicit one wins.

Hold the code until one of those succeeds.

### 4.6 "Have an invite code?" on the signup screen

Prefill it when the code arrived by deep link, and leave it editable and
**visible** otherwise.

This is not a nicety. Tapping a link without the app installed sends the user to
the App Store, and the app then launches with no code — iOS does not carry it
across an install, and recovering it would need device fingerprinting, which
isn't worth the privacy cost. This field is the only recovery path for
share-to-install traffic, which is a large share of referrals.

### 4.7 Why a dropped code costs more than one referral

Attribution builds a tree. Someone who signs up without the code becomes a
*root* rather than a child, so:

- everyone they later refer is invisible to the original referrer, permanently;
- second-degree points (5/10) never reach the referrer at all;
- any "around the world" circuit that would have closed through that branch never
  fires, and nothing anywhere reports that it should have.

None of that surfaces as an error. It just quietly reads as a less successful
referrer.

---

## 5. Endpoint specifications

Base URL is the API server. All paths below are absolute.
Authenticated calls take `Authorization: Bearer <accessToken>`.

| Endpoint | Status | Auth |
| --- | --- | --- |
| `GET /api/v1/referrals/me` | unchanged | user |
| `GET /api/v1/referrals/me/stats` | changed — three new fields | user |
| `POST /api/v1/referrals/shares` | **new** | user |
| `POST /api/v1/referrals/clicks` | ⚠️ body field renamed | none |
| `POST /api/v1/auth/signup` | unchanged | none |
| `POST /api/v1/auth/social` | unchanged | none |
| `POST /api/v1/auth/verify-email` | unchanged shape, new side effect | user |
| `POST /api/v1/auth/resend-verification-email` | unchanged, now matters more | user |
| `POST /api/v1/guest-sessions/:id/referral` | unchanged | none |

### 5.1 `GET /api/v1/referrals/me`

The card's link and every share string. The code is minted on the first call and
stable from then on.

```jsonc
// 200
{
  "code": "K7M3QP9XVT",
  "campaign": "launch",                    // "launch" | "evergreen"
  "link": "https://kinkane.app/r/K7M3QP9XVT/elisabeth-green",
  "message": "📚 Come on a reading adventure with me! …",
  "whatsapp": "https://wa.me/?text=…",     // open directly
  "sms": "sms:?&body=…",                   // open directly
  "email": {
    "subject": "Come on a reading adventure with me 🌍📚",
    "body": "Hey! I'm taking Kinkané's Around the World in 80 Days challenge…",
    "mailto": "mailto:?subject=…&body=…"   // open directly
  },
  "copy": "…",                             // for the clipboard button
  "videoUrl": "https://kinkane.app/about"  // returned; no slot in the design
}
```

**Use the returned strings rather than composing text in the app.** Each already
carries its own `?c=` channel tag, so wording stays identical across platforms
and channels stay attributable. The launch/evergreen copy switch is already
implemented server-side — the prefill wording in the Figma notes is what these
strings contain, so do not hardcode that text in the app. `campaign` tells you
which set is in force, for matching campaign artwork.

Open to every signed-up account, **including lapsed ones**. Referral is
deliberately not behind the Kinkané Plus gate.

### 5.2 `GET /api/v1/referrals/me/stats`

Three fields added. Nothing was removed or redefined, so existing parsing keeps
working. **The card only needs `points`.**

```jsonc
// 200
{
  "clicks": 84,              // unique link taps, bots excluded
  "signups": 18,             // everyone who signed up, credited or not
  "sent": 18,                // NEW — invites + shares this user initiated
  "successful": 12,          // NEW — verified signups; the ones that scored
  "pending": 6,              // NEW — signed up, not yet verified
  "countriesReached": ["GB", "GH", "NG", "US"],   // whole network, any depth
  "points": 340,             // ← the card's "You have earned N points"
  "pointsByKind": {
    "sameCountry": 12, "sameContinent": 100, "crossContinent": 180,
    "indirectSameContinent": 10, "indirectCrossContinent": 20, "fullCircuit": 30
  },
  "hasCircuit": true,
  "country": "GH"
}
```

The three new fields drive the **web** referral page's funnel card, not anything
in the app. Two notes in case they ever surface here: they **do not sum** (`sent`
counts what the user sent; `successful` and `pending` count who arrived,
including people who got the link second-hand from a forwarded message), and
`pending` is the set of people worth nudging to verify.

`pointsByKind` breaks the total down if the card ever wants to explain where
points came from — the keys match the table in §2.2.

`countriesReached` spans the **whole network** — every descendant at any depth —
while `signups`, `successful` and `pending` count only people the user
personally referred. The asymmetry is deliberate: the funnel is about who they
brought in, whereas reach is the point of a competition called Around the World
and would be meaningless if it stopped at one generation.

`country` is resolved once at signup and then frozen. A user showing `null`
**scores nothing**, so a null is worth surfacing to support rather than hiding.

### 5.3 `POST /api/v1/referrals/shares` — new

Call when the user completes a share from the card's SMS / WhatsApp / Copy
buttons.

```jsonc
// Request
{ "channel": "whatsapp" }        // whatsapp | sms | copy | link  — FOUR values

// 202
{ "recorded": true }
```

`email` is **not** valid here.

**Why call it when the card doesn't display the number.** WhatsApp, SMS and
copy-to-clipboard happen entirely on the device; the server never sees them.
This call is the only record that a share happened, and it feeds the "Sent"
figure the web referral page displays. Without it, a user who shares heavily from
the app shows as having sent nothing.

**Fire on completion, not on open.** On iOS, `UIActivityViewController`'s
completion handler reports whether the user completed or cancelled — only call on
completion. Every call writes a new row (unlike email invites, there is no
recipient to dedupe against), so reporting cancelled shares permanently inflates
the figure.

Rate limit 60/hour. A `429` is not worth surfacing to the user — swallow it. The
share already happened; only the bookkeeping failed.

### 5.4 `POST /api/v1/referrals/clicks` — ⚠️ field renamed

No auth — the tap happens before there is an account.

```jsonc
// Request — use this
{ "referralCode": "K7M3QP9XVT", "channel": "whatsapp" }

// Request — still accepted, deprecated
{ "code": "K7M3QP9XVT", "channel": "whatsapp" }

// 202 — always, even for a code that does not exist
{ "ok": true }
```

`referralCode`: required, `^[0-9A-Za-z]{6,32}$`.
`channel`: optional, **six values** — `whatsapp | sms | email | copy | link | app`.

`code` is still accepted because installed builds cannot be updated
retroactively; if both are sent, `referralCode` wins. **Change it anyway** — the
alias will be removed, and there is no deprecation signal in the response to warn
you when that happens.

The 202 is unconditional so this cannot be used to probe which codes are real.
**Never treat the response as validation of the code.**

Rate limit 120 per 15 minutes.

### 5.5 `POST /api/v1/auth/signup` — referral fields

No auth. Only the referral-relevant fields are shown; the rest of the body is
unchanged.

```jsonc
// Request
{
  "name": "Elisabeth Green",
  "email": "elisabeth@example.com",
  "password": "Password1!",
  "guestSessionId": "3f8a1c22-9b4e-4d71-8c2a-5e6f7a8b9c01",  // optional
  "referralCode": "K7M3QP9XVT",                              // optional
  "referralChannel": "whatsapp"                              // optional
}

// 201
{
  "user": { "id": 4821, "name": "Elisabeth Green",
            "email": "elisabeth@example.com", "emailVerified": false },
  "accessToken": "…",
  "refreshToken": "…"
}
```

`referralChannel` accepts **five values** here — `whatsapp | sms | email | copy |
link`. Note `app` is not among them, unlike `/referrals/clicks`.

Password rules: minimum length plus at least one uppercase, one lowercase, one
number and one special character.

Note `emailVerified: false`. The referral is recorded but **not yet credited**.

### 5.6 `POST /api/v1/auth/social` — referral fields

No auth.

```jsonc
// Request
{
  "idToken": "<firebase-id-token>",
  "guestSessionId": "3f8a1c22-…",   // optional for returning users, required for new ones
  "referralCode": "K7M3QP9XVT",     // optional
  "referralChannel": "whatsapp"     // optional
}

// 200 existing user / 201 new user
{ "user": { "id": 4821, "name": "…", "email": "…", "emailVerified": true },
  "accessToken": "…", "refreshToken": "…" }
```

Social signup is a signup: it attributes exactly as the email path does. The
difference that matters — Google has already verified the address, so the account
is created with `emailVerified: true` and **the referral is credited
immediately**. There is no pending state on this path.

### 5.7 `POST /api/v1/auth/verify-email` — where points are earned

**Auth required.** Validates the 6-digit OTP emailed at signup.

```jsonc
// Request
{ "otp": "123456" }

// 200
{ "message": "Email verified successfully" }

// 400 — invalid or expired code
{ "error": "Invalid or expired verification code" }
```

The OTP expires after 15 minutes and is single-use. It is looked up scoped to the
authenticated caller, never by value alone, so the access token is required.

On success the server credits the referral that brought this user in and looks
for any circuit the chain just closed. That work runs outside the verification
transaction and unawaited, so a scoring failure can never turn a successful
verification into an error the user has to retry.

### 5.8 `POST /api/v1/auth/resend-verification-email`

**Auth required.** No body.

```jsonc
// 200
{ "message": "If your email is not yet verified, a new link has been sent" }
```

Issues a fresh OTP and resets the 15-minute expiry. A no-op (but still 200) if
the address is already verified. This is the recovery path for a referral stuck
uncredited.

### 5.9 `POST /api/v1/guest-sessions/:id/referral`

No auth. Parks a code on an **existing** guest session so it survives onboarding.
The session comes from the recommendations flow; this endpoint does not create
one.

```jsonc
// POST /api/v1/guest-sessions/3f8a1c22-9b4e-4d71-8c2a-5e6f7a8b9c01/referral
{ "referralCode": "K7M3QP9XVT" }

// 200
{ "ok": true }
```

`:id` must be a valid UUID v4 — a malformed id returns 400
`{ "error": "Invalid session ID" }` before the body is read.
`referralCode`: required, `^[0-9A-Za-z]{6,32}$`.
404 if the session is missing or expired. Rate limit 60 per 15 minutes.

The code is stored as given and only resolved at signup — an unknown code reads
as "no referral" then, rather than failing onboarding here.

---

## 6. The Email button — an open question

Two valid implementations, and they behave differently:

- **`email.mailto` from `GET /referrals/me`** — opens the user's mail client with
  subject and body prefilled. Consistent with the other three buttons, works
  offline, and the user sees what they're sending. Records nothing on its own,
  and `email` is not a valid `/shares` channel — so either pass `link` as the
  channel, or accept that mailto shares go uncounted.
- **`POST /api/v1/referrals/invite` with `{ "email": "friend@example.com" }`** —
  the server sends the message and records it automatically, no `/shares` call
  needed. Returns `202 { "queued": true }`. Needs an address-entry UI the design
  doesn't have, and is rate-limited to 20/hour.

The design's flat row of four buttons implies the mailto route. **Confirm with
design which is intended** — this is a genuine fork, not an implementation
detail.

---

## 7. Integration order

1. **Rename `code` → `referralCode`** in the existing `/referrals/clicks` call.
   One line; do it first so it can't be forgotten.
2. **Build the card** on `GET /referrals/me` + `GET /referrals/me/stats`. Render
   `link` verbatim; use the returned share strings.
3. **Add `POST /referrals/shares`** on share completion.
4. **Resolve the Email button fork** with design (§6).
5. **Raise the missing verification screen** (§2.3) — this blocks the feature
   working at all for email/password signups.
6. **Raise the two copy conflicts** (§2.1, §2.2).

---

## 8. Silent failure modes

None of these produce an error. All produce a screen that looks fine and is
wrong.

| If you skip… | What happens |
| --- | --- |
| `POST /referrals/clicks` on deep-link launch | `clicks` quietly becomes "people without the app". Worsens as installs grow. Attribution still works, so nothing looks broken. |
| `POST /referrals/shares` on share completion | The web referral page shows this user as having sent nothing. |
| Carrying the referral code to signup | The user becomes a tree *root* instead of a child. The referrer permanently loses them, everyone they later refer, all second-degree points, and any circuit that would have closed through that branch. Nothing reports this. |
| Email verification | Every email/password referral sits uncredited forever. The card reads 0 points regardless of how many friends joined. |
| Handling a `null` `country` | That user scores nothing and no error says so. |

---

## 9. What did not change

- **The referral link format** — `https://kinkane.app/r/CODE/name-slug`, with
  `/r/CODE` working slug-less. Deep-link registration is unchanged.
- **The code format** — random 10-character Crockford base32, excluding I, L, O
  and U because a code is read aloud and retyped more often than a password is.
  Deliberately not derived from the user's name.
- **The share strings** from `GET /referrals/me`, including the launch/evergreen
  copy switch.
- **The scoring rules** in §2.2. Only *when* points are awarded changed.
- **Most `GET /referrals/me/stats` fields** — `clicks`, `signups`, `points`,
  `pointsByKind`, `hasCircuit` and `country` all keep their previous meaning and
  their previous parsing.

  The one exception is **`countriesReached`, which widened**: it used to count
  only the countries of people the user personally referred, and now spans the
  whole network at any depth (see §5.2). Same type, same field name, larger
  numbers. Nothing needs to change in the app to read it, but a screen that
  labels it "countries your friends are in" is now describing something broader.

---

## 10. Backend status

The backend code is written, typechecked and unit-tested. **The database
migrations have not been run yet.** Until they are:

- `POST /referrals/shares` returns 500.
- `GET /referrals/me/stats` does not return `sent`, `successful` or `pending`.

Neither is an app bug. Confirm the migrations are applied before investigating
either symptom.

The `/r/*` proxy on `kinkane.app` (§4.3) is also not yet applied, which will
affect click counts observed during testing.
