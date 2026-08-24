import {
  ref, resp, json, body, object, param, authErrors, publicEndpoint,
} from '../helpers';

const TAG = 'Authentication';

const passwordSchema = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
  description:
    'At least 8 characters, and must contain an uppercase letter, a lowercase letter, a number, and one of `!@#$%^&*()-_+=[]{}|;:,.<>?`~`. Each unmet rule comes back as its own message in the 400.',
  example: 'Correct-Horse9',
};

const referralCodeSchema = {
  type: 'string',
  pattern: '^[0-9A-Za-z]{6,32}$',
  description:
    'The code from the invite link the user arrived through, if any. An unknown code is treated as "no referral" rather than failing signup. Falls back to whatever was parked on the guest session.',
  example: 'K7M2QX',
};

const referralChannelSchema = {
  type: 'string',
  enum: ['whatsapp', 'sms', 'email', 'copy', 'link'],
  description: 'How the invite reached them, for attribution reporting.',
  example: 'whatsapp',
};

const guestSessionIdSchema = {
  type: 'string',
  format: 'uuid',
  description:
    'The `guestSessionId` from `POST /recommendations`. Supplying it migrates the onboarding quiz answers, chosen books and swipe history onto the new account. Omit it if the user skipped onboarding.',
  example: 'f1e2d3c4-b5a6-4978-8b0c-1d2e3f4a5b6c',
};

export const authPaths = {
  '/api/health': {
    get: {
      tags: ['Service'],
      ...publicEndpoint,
      summary: 'Health check',
      description:
        'Liveness probe. Sits outside API versioning and outside the rate limiter, so it is safe to poll. Returns 200 whenever the process is up — it does **not** check the database or Redis, so a 200 here does not promise the API is fully functional.',
      responses: {
        200: json('The process is running.',
          object({
            status: { type: 'string', example: 'ok' },
            service: { type: 'string', example: 'kinkane-server' },
          }),
          { status: 'ok', service: 'kinkane-server' }),
      },
    },
  },

  '/api/v1/auth/signup': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Create an account with email and password',
      description: [
        'Registers a new email/password account and returns a token pair — the user is signed in immediately, with no separate login call.',
        '',
        'A **90-day Kinkané Plus trial** starts synchronously before the tokens are returned, so the account is already `tier: plus, status: trialing` by the time the client reads the response.',
        '',
        'A 6-digit verification code is emailed in the background. `emailVerified` comes back `false` and the account is fully usable regardless — verification is not a gate on anything here.',
        '',
        '**Rate limit:** 10 per hour per IP.',
      ].join('\n'),
      requestBody: body(object({
        name: { type: 'string', minLength: 1, maxLength: 100, example: 'Ama Boateng' },
        email: { type: 'string', format: 'email', example: 'ama@example.com' },
        password: passwordSchema,
        guestSessionId: guestSessionIdSchema,
        referralCode: referralCodeSchema,
        referralChannel: referralChannelSchema,
      }, ['name', 'email', 'password'])),
      responses: {
        201: json('Account created and signed in.', ref('AuthSuccess')),
        400: resp('ValidationError'),
        409: json('That email is already registered.', ref('Error'),
          { error: 'Email already registered' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/login': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Sign in with email and password',
      description: [
        'Exchanges credentials for a fresh token pair.',
        '',
        'Deliberately timing-safe and uniform: an unregistered email and a wrong password produce the same 401 with the same message, so this cannot be used to discover which addresses have accounts.',
        '',
        '**This is the endpoint to use to get a token for trying out the rest of this page.** Copy `accessToken` from the response into the **Authorize** dialog at the top.',
        '',
        '**Rate limit:** 20 per 15 minutes per IP.',
      ].join('\n'),
      requestBody: body(object({
        email: { type: 'string', format: 'email', example: 'ama@example.com' },
        password: { type: 'string', example: 'Correct-Horse9' },
      }, ['email', 'password'])),
      responses: {
        200: json('Signed in.', ref('AuthSuccess')),
        401: json('Wrong email or wrong password — indistinguishable by design.', ref('Error'),
          { error: 'Invalid credentials' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/social': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Sign in or register with Google, Facebook or Apple',
      description: [
        'Takes a Firebase ID token obtained by the client SDK and resolves it to a Kinkané session. Three outcomes, distinguished by the status code:',
        '',
        '- **201** — no account existed for this provider identity, so one was created and a 90-day Plus trial started.',
        '- **200, account already linked** — a returning user.',
        '- **200, account existed under the same email** — the provider is linked to that existing account. No new account, and **no trial**, since that account already had its own.',
        '',
        '`guestSessionId` is honoured only in the first case; returning users ignore it either way.',
        '',
        '**Rate limit:** 20 per 15 minutes per IP.',
      ].join('\n'),
      requestBody: body(object({
        idToken: {
          type: 'string',
          description: 'Firebase ID token from `getIdToken()` on the client. Not the provider’s own access token.',
          example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjE2NzAyM…',
        },
        guestSessionId: guestSessionIdSchema,
        referralCode: referralCodeSchema,
        referralChannel: referralChannelSchema,
      }, ['idToken'])),
      responses: {
        200: json('Returning user, or an existing account newly linked to this provider.', ref('AuthSuccess')),
        201: json('New account created, trial started.', ref('AuthSuccess')),
        400: resp('ValidationError'),
        401: json('The Firebase ID token is invalid or expired.', ref('Error'),
          { error: 'Invalid authentication token' }),
        422: json(
          'The social account has no email address on it — Apple private relay can be declined, and Facebook accounts need not have one. There is nothing to key an account on, so the client must fall back to email signup.',
          ref('Error'),
          { error: 'No email address on this social account' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/refresh': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Exchange a refresh token for a new token pair',
      description: [
        'Rotating refresh: the submitted token is **deleted the moment it is accepted**, and a new one is issued alongside the new access token. Persist the returned `refreshToken` before doing anything else — replaying the old one returns 401 and logs the user out.',
        '',
        'In normal operation a client rarely needs this. Authenticated responses attach a replacement access token in `X-New-Access-Token` when the current one is within 5 minutes of expiry; reading that header keeps a session alive indefinitely. This endpoint is for when the app was closed long enough for the access token to lapse entirely.',
        '',
        '**Rate limit:** 60 per 15 minutes per IP.',
      ].join('\n'),
      requestBody: body(object({
        refreshToken: { type: 'string', example: 'b7f3a1c2-9d84-4e17-9c55-2f0a6d3e8b41' },
      }, ['refreshToken'])),
      responses: {
        200: json('New token pair. Store both.',
          object({
            accessToken: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…' },
            refreshToken: { type: 'string', example: '3c9d8e7f-1a2b-4c3d-8e9f-0a1b2c3d4e5f' },
          })),
        401: json('The token was not found, already used, or has expired.', ref('Error'),
          { error: 'Invalid refresh token' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/logout': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Invalidate a refresh token',
      description:
        'Deletes the refresh token server-side. The **access token is not revoked** — it stays valid until it expires (15 minutes by default), because it is verified by signature and never looked up. For an immediate logout, discard both tokens client-side as well; this call only guarantees the session cannot be extended.',
      requestBody: body(object({
        refreshToken: { type: 'string', example: 'b7f3a1c2-9d84-4e17-9c55-2f0a6d3e8b41' },
      }, ['refreshToken'])),
      responses: {
        200: json('Logged out.', object({ message: { type: 'string', example: 'Logged out successfully' } })),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/me': {
    get: {
      tags: [TAG],
      summary: 'Get the signed-in user',
      description:
        'The caller’s full profile, including their live subscription state and which sign-in providers are attached to the account. This is the call to make on app launch to decide what the user can see.',
      responses: {
        200: json('The authenticated user.',
          object({
            user: object({
              id: { type: 'integer', example: 4412 },
              name: { type: 'string', example: 'Ama Boateng' },
              email: { type: 'string', format: 'email', example: 'ama@example.com' },
              emailVerified: { type: 'boolean', example: true },
              photoUrl: { type: 'string', format: 'uri', nullable: true, example: null },
              phone: { type: 'string', nullable: true, description: 'E.164, or null.', example: '+233201234567' },
              joinedYear: { type: 'integer', example: 2026 },
              subscription: ref('Subscription'),
              providers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Firebase provider ids, plus `password` when the account has one set.',
                example: ['google.com', 'password'],
              },
            }),
          })),
        ...authErrors,
        404: resp('NotFound'),
      },
    },
  },

  '/api/v1/auth/verify-email': {
    post: {
      tags: [TAG],
      summary: 'Confirm an email address with the code that was sent',
      description: [
        'Validates the 6-digit code emailed at signup and flips `emailVerified` to true.',
        '',
        'Requires an access token, and the code is looked up **scoped to the caller** rather than by value alone — so a valid code cannot be used against somebody else’s account. Codes expire after 15 minutes and are single-use.',
        '',
        '**Rate limit:** 10 per hour per IP.',
      ].join('\n'),
      requestBody: body(object({
        otp: { type: 'string', pattern: '^\\d{6}$', example: '482913' },
      }, ['otp'])),
      responses: {
        200: json('Email verified.', object({ message: { type: 'string', example: 'Email verified' } })),
        400: json('The code is wrong, expired, or already used.', ref('Error'),
          { error: 'Invalid or expired verification code' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/auth/resend-verification-email': {
    post: {
      tags: [TAG],
      summary: 'Send a fresh verification code',
      description:
        'Issues a new 6-digit code and restarts the 15-minute expiry. If the address is already verified this is a no-op that still returns 200 with an identical body — the response cannot be used to probe whether an account is verified. **Rate limit:** 5 per hour per IP.',
      responses: {
        200: json('A code has been sent, or the address was already verified.',
          object({ message: { type: 'string', example: 'Verification email sent' } })),
        ...authErrors,
      },
    },
  },

  '/api/v1/auth/change-password': {
    post: {
      tags: [TAG],
      summary: 'Change the password',
      description:
        'Requires the current password as confirmation. Accounts created through a social provider have no password to change and receive a 400 — check `providers` on `GET /auth/me` before showing this option.',
      requestBody: body(object({
        currentPassword: { type: 'string', example: 'Correct-Horse9' },
        newPassword: passwordSchema,
      }, ['currentPassword', 'newPassword'])),
      responses: {
        200: json('Password changed.', object({ message: { type: 'string', example: 'Password changed' } })),
        400: json('Validation failed, or this is a social-only account with no password set.',
          ref('ValidationError')),
        401: json('The current password is wrong.', ref('Error'), { error: 'Incorrect password' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/forgot-password': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Send a password reset link',
      description:
        'Always returns 200, whether or not the address has an account — otherwise this endpoint would enumerate registered users. **Rate limit:** 5 per hour per IP.',
      requestBody: body(object({
        email: { type: 'string', format: 'email', example: 'ama@example.com' },
      }, ['email'])),
      responses: {
        200: json('If that address has an account, a reset link is on its way.',
          object({ message: { type: 'string', example: 'If that email is registered, a reset link has been sent' } })),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/reset-password': {
    post: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Set a new password using a reset token',
      description:
        'The token comes from the emailed link, expires after 1 hour, and is single-use. On success **every active session is invalidated** — all refresh tokens for the account are deleted, so other devices are signed out. **Rate limit:** 5 per hour per IP.',
      requestBody: body(object({
        token: { type: 'string', example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
        password: passwordSchema,
      }, ['token', 'password'])),
      responses: {
        200: json('Password reset; all sessions invalidated.',
          object({ message: { type: 'string', example: 'Password has been reset' } })),
        400: json('The token is invalid or expired, or the new password failed validation.',
          ref('ValidationError')),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  '/api/v1/auth/account': {
    delete: {
      tags: [TAG],
      summary: 'Delete the account permanently',
      description: [
        '**Irreversible.** Deletes the account and everything attached to it: library, preferences, interaction history, posts, and subscription record. A goodbye email is sent afterwards.',
        '',
        'Confirmed with the account password, so social-only accounts cannot currently use this endpoint and receive a 400.',
        '',
        'Discard both tokens on receipt of the 200.',
      ].join('\n'),
      requestBody: body(object({
        password: { type: 'string', example: 'Correct-Horse9' },
      }, ['password'])),
      responses: {
        200: json('Account deleted.', object({ message: { type: 'string', example: 'Account deleted' } })),
        400: json('Password missing, or this is a social account with no password to check.',
          ref('Error'), { error: 'Password is required' }),
        401: json('The password is wrong.', ref('Error'), { error: 'Incorrect password' }),
        429: resp('RateLimited'),
        500: resp('ServerError'),
      },
    },
  },

  // ── Email change ───────────────────────────────────────────────────────────

  '/api/v1/user/email-change/request': {
    post: {
      tags: [TAG],
      summary: 'Start changing the account email address',
      description: [
        'Checks the new address is free, then sends a 6-digit code **to the new address** and a cancellation link **to the current one**. The change is not applied until the code is submitted to `/verify`.',
        '',
        'Starting a second request overwrites any pending one — the previously issued code stops working.',
        '',
        '**Rate limit:** 5 per hour per IP.',
      ].join('\n'),
      requestBody: body(object({
        newEmail: { type: 'string', format: 'email', example: 'ama.boateng@example.com' },
      }, ['newEmail'])),
      responses: {
        200: json('A confirmation code has been sent to the new address.',
          object({ message: { type: 'string', example: 'Verification code sent' } })),
        400: json('Invalid address, or it is the address already on the account.', ref('ValidationError')),
        409: json('That address belongs to another account.', ref('Error'),
          { error: 'Email already in use' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/email-change/verify': {
    post: {
      tags: [TAG],
      summary: 'Confirm the email change',
      description:
        'Commits the pending change. **All active sessions are invalidated** on success — the email is part of the token payload, so every existing token is stale. Send the client to the login screen.',
      requestBody: body(object({
        otp: { type: 'string', pattern: '^\\d{6}$', example: '482913' },
      }, ['otp'])),
      responses: {
        200: json('Email changed; all sessions invalidated.',
          object({ message: { type: 'string', example: 'Email updated' } })),
        400: json('The code is wrong or expired, or there is no pending change.', ref('Error'),
          { error: 'Invalid or expired code' }),
        409: json('Someone else claimed that address while this request was pending.', ref('Error'),
          { error: 'Email no longer available' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/email-change/resend': {
    post: {
      tags: [TAG],
      summary: 'Resend the email-change code',
      description:
        'Issues a fresh code to the pending new address and a new cancellation link to the current one, resetting the 15-minute expiry. **Rate limit:** 5 per hour per IP.',
      responses: {
        200: json('A new code has been sent.',
          object({ message: { type: 'string', example: 'Verification code resent' } })),
        400: json('There is no pending email change to resend.', ref('Error'),
          { error: 'No pending email change' }),
        ...authErrors,
      },
    },
  },

  '/api/v1/user/email-change/cancel': {
    get: {
      tags: [TAG],
      ...publicEndpoint,
      summary: 'Cancel a pending email change',
      description:
        'Called from the link sent to the **old** address. Deliberately unauthenticated: the whole point is that it works when the account has been taken over and the real owner can no longer sign in.',
      parameters: [
        param('token', 'query', { type: 'string' },
          'The cancellation token from the email. Single-use.', { required: true, example: 'c4a8…' }),
      ],
      responses: {
        200: json('The pending change was cancelled.',
          object({ message: { type: 'string', example: 'Email change cancelled' } })),
        400: json('The token is invalid or has expired.', ref('Error'),
          { error: 'Invalid or expired token' }),
        500: resp('ServerError'),
      },
    },
  },
};
