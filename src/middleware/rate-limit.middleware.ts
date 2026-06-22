import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request } from 'express';
import { redis } from '../lib/redis';
import type { AuthenticatedRequest } from './auth.middleware';

const json429 = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ error: 'Too many requests — please try again later' });

const sendCommand = (...args: string[]) =>
  (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<import('rate-limit-redis').RedisReply>;

// General API: 300 requests per 15 minutes — comfortable for browsing books
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:api:', sendCommand }),
});

// Signup: 10 per hour — people don't create accounts frequently
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:signup:', sendCommand }),
});

// Login: 20 per 15 minutes — brute-force protection without locking out real users
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:login:', sendCommand }),
});

// Refresh: 60 per 15 minutes — apps refresh silently every time the access token expires
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:refresh:', sendCommand }),
});

// Recommendations: 20 per hour — each miss triggers Gemini API calls (embedding + flash-lite)
// Cache hits are free, but uncached requests have real cost; this keeps abuse in check
export const recommendationsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:recommendations:', sendCommand }),
});

// Password reset: 5 per hour — prevents email bombing and brute-forcing reset tokens
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:password-reset:', sendCommand }),
});

// Verify-email link: 20 per hour per IP — the token itself is a 40-byte random
// value (unguessable), so this limiter only needs to absorb shared-IP traffic
// (NAT/CGNAT) and accidental double-clicks, not slow down a brute-force attempt.
export const verifyEmailLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:email-verify-link:', sendCommand }),
});

// Resend verification email: 5 per hour per user — authenticated route, so key
// by user ID rather than IP. Prevents a single account from triggering unbounded
// SendGrid sends regardless of how many IPs they call from.
export const resendVerificationEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: (req: Request) => String((req as AuthenticatedRequest).user.id),
  store: new RedisStore({ prefix: 'rl:email-verify-resend:', sendCommand }),
});

// Email change: 5 per hour — prevents OTP email bombing to arbitrary addresses
export const emailChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:email-change:', sendCommand }),
});
