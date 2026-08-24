import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request } from 'express';
import { redis } from '../lib/redis';
import type { AuthenticatedRequest } from './auth.middleware';

const json429 = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ error: 'Too many requests — please try again later' });

/**
 * Keys a limiter by the authenticated user, falling back to their IP.
 *
 * Every limiter using this sits behind `requireAuth`, so the fallback should be
 * unreachable. It exists because the alternative — reading `.user.id` off a
 * request that doesn't have one — throws a TypeError inside express-rate-limit
 * and surfaces as an unexplained 500. A limiter is a safety control, and it
 * should degrade to limiting *more* narrowly rather than failing the request.
 *
 * `ipKeyGenerator` rather than raw `req.ip`: it collapses IPv6 addresses to
 * their /56 prefix, so a client with a whole address range can't sidestep the
 * limit by changing the low bits of its address on every request.
 */
const byUser = (req: Request): string => {
  const id = (req as AuthenticatedRequest).user?.id;
  return id !== undefined ? String(id) : ipKeyGenerator(req.ip ?? '');
};

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

// Checkout / billing portal: 20 per hour per user — each one is a live Stripe
// API call, and nobody legitimately needs to start twenty checkouts an hour.
// Keyed by user rather than IP so one person on a shared network can't lock
// everyone else out of subscribing.
/**
 * Guest order lookup and claim: 10 per 15 minutes, per IP.
 *
 * Keyed by IP rather than by user because the whole point of these endpoints is
 * that there is no user yet. The token they take is 256 bits, so this is not
 * what stops a brute force — that is arithmetically hopeless already. It is
 * here to stop an attacker walking the *reference* space to find which orders
 * exist by timing or by response shape, and to keep an unauthenticated endpoint
 * that does a hash comparison from being a cheap way to burn our CPU.
 */
export const guestOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:guestorder:', sendCommand }),
});

/**
 * Admin console sign-in.
 *
 * Its own bucket rather than sharing `loginLimiter` with the customer app. They
 * are keyed by IP, so a shared bucket means two bad outcomes: someone brute
 * forcing the *customer* login from an address locks staff out of the console
 * at the moment they most need it, and an office behind one NAT spends the same
 * budget twice.
 *
 * Tighter than the customer limit because the population is a handful of people
 * who know their own password, not the public.
 */
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:adminlogin:', sendCommand }),
});

/**
 * Contact form. Unauthenticated and it sends mail, which makes it a spam relay
 * if it is not bounded — three an hour is generous for a human with a problem
 * and useless to anyone with a script.
 */
export const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  store: new RedisStore({ prefix: 'rl:contact:', sendCommand }),
});

export const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: byUser,
  store: new RedisStore({ prefix: 'rl:checkout:', sendCommand }),
});

// Payment confirmation: 60 per minute per user. This endpoint is polled by a
// client sitting on a "confirming your payment" spinner, so it has to tolerate
// a tight loop — but a pending payment falls through to a live Stripe lookup,
// and the 2-second re-check guard on the payment row is written *after* the
// call returns, so simultaneous polls can each start their own request before
// any of them records the attempt. This bounds that.
export const paymentConfirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: byUser,
  store: new RedisStore({ prefix: 'rl:payment-confirm:', sendCommand }),
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

// Verify-email OTP: 10 attempts per hour per user — authenticated route, so
// key by user ID. A 6-digit OTP is a 1e6-value space, materially guessable
// with enough attempts, so (unlike the old unguessable-token design) this
// limiter is the actual brute-force guard, not just shared-IP absorption.
export const verifyEmailOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: byUser,
  store: new RedisStore({ prefix: 'rl:email-verify-otp:', sendCommand }),
});

// Resend verification email: 5 per hour per user — authenticated route, so key
// by user ID rather than IP. Prevents a single account from triggering unbounded
// email-provider sends regardless of how many IPs they call from.
export const resendVerificationEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: byUser,
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

// Follow requests: 30 per hour per sender — each one emails the target user,
// so this is the same "don't let one account email-bomb arbitrary third
// parties" concern as emailChangeLimiter/passwordResetLimiter, just keyed by
// the authenticated sender instead of IP.
export const followRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
  keyGenerator: byUser,
  store: new RedisStore({ prefix: 'rl:follow-request:', sendCommand }),
});
