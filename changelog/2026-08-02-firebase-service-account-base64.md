# Firebase credentials: one base64 variable instead of a pasted private key

**Date:** 2026-08-02

## What changed

Firebase Admin credentials can now be supplied as the whole service-account JSON
file, base64-encoded into a single environment variable
(`FIREBASE_SERVICE_ACCOUNT_B64`). The three separate variables
(`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`) still
work and are read whenever the base64 variable is unset, so nothing has to
change in an environment that is currently healthy.

Two behaviour changes come with it, both about failing visibly rather than
quietly — see below.

## Why

The deployed server was logging this at startup and then carrying on:

```
[firebase] Init failed — Firebase will be unavailable: Failed to parse private key: Error: error:1E08010C:DECODER routines::unsupported
```

That OpenSSL message means the private key isn't valid PEM. The cause is the
transport, not the key: a PEM block pasted into a dashboard field rarely
survives intact. Render stores the value verbatim, with no dotenv layer in
front of it, so the double quotes that are correct in a `.env` file become
literal characters in the string and the key no longer begins at character
zero. A multi-line paste can arrive with its newlines flattened instead. Either
way the result is the same opaque decoder error, which says nothing about
quoting or newlines and sends you looking at the key itself.

Base64 removes the failure mode rather than working around it: the encoded
value is a single line of `[A-Za-z0-9+/=]`, with no quotes, no newlines and no
leading punctuation for a form to mangle.

## The two behaviour changes

**Missing credentials still exit at startup, and now so does a malformed
service-account blob.** Previously the three variables were required by the zod
schema, so a missing one exited the process. The schema can't express "one of
these two sets", so all four are now optional there and
`resolveFirebaseCredentials()` in `src/config/index.ts` enforces the real rule,
exiting with a message that names both accepted forms.

**A private key that is present but unparseable now throws instead of
warning.** `src/lib/firebase.ts` used to catch the init failure and log a
warning, which is how the broken deploy stayed up. That is the worse outcome:
Firebase backs Google sign-in and push notifications, so the server passed
Render's health check while rejecting every social login, and the only evidence
was one line near the top of the deploy log. It now throws, and the thrown
message explains what a `DECODER routines::unsupported` error actually means
and points at the base64 variable.

This is a deliberate trade: a bad Firebase key now takes the deploy down. Given
that the alternative is a server that looks healthy and can't authenticate
anyone, a failed deploy is the cheaper failure.

## Checking an environment

`npm run firebase:check` (`scripts/check-firebase.ts`) answers "are the Firebase
credentials in this environment actually good?" without a deploy and a login
attempt. It reports the credential source, checks the private key is
well-formed PEM, and then mints a real access token — which is the only way to
prove the key, the client email and the clock all line up. Pass an ID token as
an argument to also exercise `verifyIdToken`, the path
`POST /api/v1/auth/social` takes.

It prints no secret material — keys are reported by length, newline count and
SHA-256 prefix — so its output is safe to paste into a ticket. The errors worth
distinguishing (`DECODER routines`, `invalid_grant`, a bad ID token) are mapped
onto what to do about each. It runs in Render's shell as well as locally.

The ID token that step needs has to come from a real sign-in.
`scripts/google-signin-test.html` is a browser harness that runs an actual
Google sign-in popup and prints the token, with `sign_in_provider` of
`google.com`. It is checked in unfinished: it needs a **Web** app registered in
the Firebase project, and only Android and iOS are registered today, so it
can't run until someone adds one.

A second script that minted tokens via the Admin SDK's custom-token exchange
was written and then dropped. It worked without a Web app, but its tokens
carried `sign_in_provider` of `custom` rather than `google.com` — so it proved
the endpoint's plumbing rather than the path production actually takes — and it
wrote a real `user_providers` row with provider `custom` that had to be cleaned
up by hand afterwards. A harness that tests the wrong provider and leaves rows
behind isn't worth maintaining alongside one that does neither.

## Out of scope

`render.yaml` isn't touched — the Firebase variables are dashboard-managed and
never appeared in it. Nothing was changed about how ID tokens are verified, and
`src/lib/push.ts` keeps its `admin.apps.length` guard.

## How it was verified

A throwaway 2048-bit RSA key was generated with `openssl genpkey` and wrapped in
a fake service-account JSON, then the real `src/config` and `src/lib/firebase`
modules were loaded against it in five configurations:

| Scenario | Result |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_B64` set | Resolves, 28 newlines in the key, admin initialises |
| Three legacy variables with `\n` escapes | Resolves identically, admin initialises |
| Legacy `FIREBASE_PRIVATE_KEY` wrapped in literal quotes | Reproduces the exact production error, now with the explanatory message |
| Base64 variable set to garbage | Exits at startup naming the `base64 -i` command |
| Nothing set | Exits at startup naming both accepted forms |

The base64 run also confirms precedence: a local `.env` supplying the three
legacy variables was present, and the resolved project id came from the base64
blob. `npx tsc --noEmit` is clean. The throwaway key was deleted afterwards.

`npm run firebase:check` was then run against the real local environment, using
`FIREBASE_SERVICE_ACCOUNT_B64`: the key parsed, and Google minted an access
token for `firebase-adminsdk-fbsvc@kinkane-7adf9.iam.gserviceaccount.com`. ID
token verification was not exercised — that needs a token from a signed-in app.
