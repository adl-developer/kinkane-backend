import rateLimit from 'express-rate-limit';

// NOTE: express-rate-limit uses an in-memory store by default. This works fine for
// a single-process deployment, but in a multi-instance or cluster setup each process
// maintains its own counter, so the effective limit becomes max * numInstances.
// For production multi-instance deploys, swap the store for a shared Redis-backed one
// (e.g. rate-limit-redis or ioredis-store) to get accurate cross-process rate limiting.

const json429 = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ error: 'Too many requests — please try again later' });

// General API: 300 requests per 15 minutes — comfortable for browsing books
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

// Signup: 10 per hour — people don't create accounts frequently
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

// Login: 20 per 15 minutes — brute-force protection without locking out real users
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

// Refresh: 60 per 15 minutes — apps refresh silently every time the access token expires
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});

// Recommendations: 20 per hour — each miss triggers Gemini API calls (embedding + flash-lite)
// Cache hits are free, but uncached requests have real cost; this keeps abuse in check
export const recommendationsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: json429,
});
