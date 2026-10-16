# Wrong referral codes are refused at signup

## What changed

Signup now checks the referral code. On `POST /api/v1/auth/signup`, and on
`POST /api/v1/auth/social` when it creates a new account:

| `referralCode` sent | Result |
|---|---|
| key missing, `null`, `""`, spaces only | Account created, no referral |
| an active code (any case, surrounding spaces trimmed) | Account created, referral attributed |
| unknown, deactivated, or malformed (wrong length/characters) | `400 { "error": "Invalid referral code.", "code": "INVALID_REFERRAL_CODE" }`, no account created |

Before this, an unknown code was silently dropped. An empty string or `null`
was rejected with a generic validation error, so the account wasn't created.

## Why

A code the person entered that silently scored nothing was invisible to them.
Now they're told, and can fix it or clear it.

## Decisions

- **Only the code in the request is checked.** A code parked on the guest
  session by an earlier invite link was never shown to the person, so they
  can't clear it. A bad one is still ignored rather than blocking the account.
- **Returning social users are never blocked.** The code is only checked when
  the sign-in creates an account.
- **One message for every wrong code.** Malformed, unknown and deactivated
  codes all get the same "Invalid referral code." message. Only a non-string
  value fails at the request schema, and it carries the same message.
- **Checked before anything is written.** A code deactivated between the check
  and the insert is dropped, and signup still succeeds.

## Verified

`referral-code-signup.test.ts` covers blank values, trimming, unknown and
malformed codes, and parked codes on both signup paths. The full unit suite
passes and the typecheck is clean.
