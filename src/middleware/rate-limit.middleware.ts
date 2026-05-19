import rateLimit from 'express-rate-limit';

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
