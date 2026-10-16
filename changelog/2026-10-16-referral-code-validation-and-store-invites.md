# Wrong referral codes refused at signup; invite links go to the app stores

## What changed

**Signup now checks the referral code.** On `POST /api/v1/auth/signup`, and on
`POST /api/v1/auth/social` when it creates a new account:

| `referralCode` sent | Result |
|---|---|
| key missing, `null`, `""`, spaces only | Account created, no referral |
| an active code (any case, surrounding spaces trimmed) | Account created, referral attributed |
| unknown, deactivated, or malformed (wrong length/characters) | `400 { "error": "Invalid referral code.", "code": "INVALID_REFERRAL_CODE" }`, no account created |

Before this, an unknown code was silently dropped. An empty string or `null`
was rejected with a generic validation error, so the account wasn't created.

**Invite links route by device.** `GET /r/:code/:slug` (and `/redirect/r/...`
in a browser), for a known code:

- **Android**: 302 to the Play Store with the code in the install referrer:
  `…details?id=com.kinkaneapp.kinkane&referrer=ref%3DCODE%26c%3DCHANNEL`.
- **iPhone**: a page showing the code, with an App Store button. The person
  types the code at signup.
- **Computers and anything else**: the same page, with both store buttons.

Unknown codes still redirect to the homepage. Phones with the app installed
still open it directly from the link. The click is still counted and the
`kk_ref` cookie is still set.

## Why

A code the person typed (or that the app prefilled) and that silently scored
nothing was invisible to them. Now they're told, and can fix it or clear it.
Invites also no longer lead to web sign-up: accounts are made in the app.

## Decisions

- **Only the code in the request is checked.** A code parked on the guest
  session by an earlier invite link was never shown to the person, so they
  can't clear it. A bad one is still ignored rather than blocking the account.
- **The app must prefill, not hide.** A code the app reads from the Play
  install referrer goes into the visible referral field and is sent as
  `referralCode`. If it's wrong, the person sees the error under the field and
  can clear it.
- **Returning social users are never blocked.** The code is only checked when
  the sign-in creates an account.
- **No clipboard copy on iPhone.** Safari allows clipboard writes only after a
  tap, so the page shows the code instead. The page has no script.
- **Channel whitelist.** Only `whatsapp | sms | email | copy | link` is
  forwarded into the Play referrer, so `?c=` can't inject extra referrer keys.
- **`Cache-Control: no-store` and `Vary: User-Agent`** on the `/r` response,
  since the answer depends on the device and names a code.
- A code deactivated between the check and the insert is dropped, and signup
  still succeeds.

## Configuration

- `PLAY_STORE_URL`: defaults to the `com.kinkaneapp.kinkane` listing.
- `APP_STORE_URL`: no default, because the App Store ID isn't known here.
  Until it's set, the page tells iPhone users to search the App Store instead
  of showing a button.

## Out of scope

- Reading the install referrer and prefilling the field: app work.
- The web `/invite` page is now only reached by links already in flight. It
  hasn't been removed from the web repo.

## Verified

`referral-code-signup.test.ts` covers blank values, trimming, unknown and
malformed codes, and parked codes on both signup paths.
`referral-invite-landing.test.ts` covers Android, iPhone and desktop
responses, referrer encoding, channel filtering, and unknown codes. Full unit
suite (1569) and endpoint suite pass; typecheck is clean.
