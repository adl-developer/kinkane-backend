import { Router, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import swaggerUi from 'swagger-ui-express';
import helmet from 'helmet';
import { redis } from '../lib/redis';
import { config } from '../config';
import { logger } from '../lib/logger';
import { buildOpenApiDocument } from '../docs/openapi';

/**
 * Password-gated interactive API documentation at /docs.
 *
 * The gate is a login form plus a signed session cookie rather than HTTP Basic:
 * Basic has no logout, browsers cache it aggressively, and it cannot carry an
 * expiry — which matters here because this page can execute real writes against
 * the production database. A cookie with a TTL can.
 *
 * The session is signed with a key derived from SWAGGER_PASSWORD itself, so
 * rotating the password invalidates every outstanding session for free.
 */

const COOKIE_NAME = 'kinkane_docs_session';
const COOKIE_PATH = '/docs';

const sessionSecret = (): string =>
  createHmac('sha256', config.swagger.password ?? '')
    .update('kinkane-swagger-docs-session-v1')
    .digest('hex');

/**
 * Constant-time password comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the
 * length, so both sides are hashed to a fixed 32 bytes first and the comparison
 * always runs over equal-length buffers.
 */
function passwordMatches(submitted: string): boolean {
  const expected = config.swagger.password;
  if (!expected) return false;

  const digest = (value: string) => createHmac('sha256', 'docs-password-compare').update(value).digest();
  return timingSafeEqual(digest(submitted), digest(expected));
}

/**
 * Minimal cookie header parsing — the app does not otherwise use cookies, and
 * a whole cookie-parser dependency for one name is not worth the supply chain.
 */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function hasValidSession(req: Request): boolean {
  const token = readSessionCookie(req);
  if (!token) return false;

  try {
    jwt.verify(token, sessionSecret());
    return true;
  } catch {
    return false;
  }
}

// ── Pages ─────────────────────────────────────────────────────────────────────

const page = (title: string, inner: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Kinkané — ${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #EEECE6; font-family: Georgia, 'Times New Roman', serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; max-width: 460px; width: 90%; padding: 48px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .logo { font-size: 18px; font-weight: bold; color: #1A1A1A; margin-bottom: 32px; text-align: center; }
    .logo span { display: inline-block; background: #1A1A1A; color: #fff; border-radius: 5px; padding: 3px 7px; margin-right: 6px; font-size: 12px; font-family: Arial, sans-serif; }
    h1 { font-size: 22px; color: #1A1A1A; margin: 0 0 12px; line-height: 1.3; text-align: center; }
    p { font-size: 14px; color: #666; line-height: 1.7; margin: 0 0 24px; text-align: center; }
    label { display: block; font-family: Arial, sans-serif; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #888; margin-bottom: 8px; }
    input { width: 100%; box-sizing: border-box; padding: 12px 14px; font-size: 15px; font-family: Arial, sans-serif; border: 1px solid #D8D5CC; border-radius: 5px; background: #FCFBF8; }
    input:focus { outline: none; border-color: #1A1A1A; }
    button { width: 100%; margin-top: 16px; padding: 13px; font-size: 15px; font-family: Arial, sans-serif; font-weight: 600; color: #fff; background: #1A1A1A; border: none; border-radius: 5px; cursor: pointer; }
    button:hover { background: #333; }
    .error { background: #FDF0EE; border: 1px solid #E8C4BC; color: #A3392A; font-family: Arial, sans-serif; font-size: 13px; padding: 10px 12px; border-radius: 5px; margin-bottom: 20px; text-align: center; }
    .note { font-family: Arial, sans-serif; font-size: 12px; color: #999; margin: 24px 0 0; line-height: 1.6; }
  </style>
</head>
<body><div class="card">${inner}</div></body>
</html>`;

const loginPage = (error?: string) => page('API documentation', `
  <div class="logo"><span>K</span>Kinkané</div>
  <h1>API documentation</h1>
  <p>This documentation is private. Enter the access password to continue.</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/docs/login">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus required />
    <button type="submit">View documentation</button>
  </form>
  <p class="note">
    This page executes real requests against the <strong>${config.nodeEnv}</strong> environment and its
    live database. Anything you send from it is not a simulation.
  </p>
`);

// ── Middleware ────────────────────────────────────────────────────────────────

const sendCommand = (...args: string[]) =>
  (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<
    import('rate-limit-redis').RedisReply
  >;

// A single shared password with no account behind it is exactly the thing worth
// brute-forcing, and the docs are a map of every endpoint in the system. Ten
// attempts an hour makes an online guessing attack pointless without getting in
// the way of someone who fat-fingered it twice.
const docsLoginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ prefix: 'rl:docs-login:', sendCommand }),
  handler: (_req, res) =>
    res.status(429).send(loginPage('Too many attempts. Try again in an hour.')),
});

/**
 * Swagger UI needs inline styles and scripts, which the app-wide helmet default
 * CSP forbids. Relaxing it globally to accommodate one page would be the wrong
 * trade, so the relaxation is scoped to this router.
 */
const docsCsp = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // Swagger UI loads its own assets same-origin; the default COEP header breaks
  // nothing here but the referrer policy matters more — a docs URL should not
  // leak to whatever a user clicks through to.
  crossOriginEmbedderPolicy: false,
});

function requireDocsSession(req: Request, res: Response, next: NextFunction): void {
  if (hasValidSession(req)) {
    next();
    return;
  }

  // A browser landing on the page gets the form; anything asking for JSON (the
  // spec fetch from an expired tab, or a script) gets a status code it can act on.
  if (req.accepts(['html', 'json']) === 'html') {
    res.status(401).send(loginPage());
    return;
  }
  res.status(401).json({ error: 'Documentation session required. Sign in at /docs.' });
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

router.use(docsCsp);

// Never let a search engine or an intermediary cache hold on to any of this.
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.post('/login', docsLoginLimiter, (req: Request, res: Response) => {
  const submitted = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!submitted || !passwordMatches(submitted)) {
    logger.warn('Failed /docs login attempt', { ip: req.ip });
    res.status(401).send(loginPage('That password is not correct.'));
    return;
  }

  const ttlSeconds = config.swagger.sessionTtlHours * 60 * 60;
  const token = jwt.sign({ scope: 'docs' }, sessionSecret(), { expiresIn: ttlSeconds });

  res.setHeader(
    'Set-Cookie',
    [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      `Path=${COOKIE_PATH}`,
      `Max-Age=${ttlSeconds}`,
      'HttpOnly',
      'SameSite=Lax',
      // Omitted outside production so the docs still work over plain HTTP on a
      // developer machine, where there is no TLS to mark the cookie against.
      ...(config.nodeEnv === 'production' ? ['Secure'] : []),
    ].join('; '),
  );

  logger.info('/docs session started', { ip: req.ip, ttlHours: config.swagger.sessionTtlHours });
  res.redirect('/docs');
});

router.post('/logout', (_req: Request, res: Response) => {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  res.redirect('/docs');
});

router.use(requireDocsSession);

/**
 * The spec itself. Served from a route rather than handed to swagger-ui as a
 * static object so that `servers` can be resolved from this request's host —
 * see buildOpenApiDocument.
 */
router.get('/openapi.json', (req: Request, res: Response) => {
  res.json(buildOpenApiDocument(req));
});

router.use(
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    // Point the UI at the dynamic spec above rather than embedding a snapshot.
    swaggerOptions: {
      url: '/docs/openapi.json',
      docExpansion: 'none',
      filter: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
      defaultModelsExpandDepth: 2,
      displayRequestDuration: true,
    },
    customSiteTitle: 'Kinkané API',
    // Stock Swagger theme, with one line of CSS and nothing else.
    //
    // `color-scheme: only light` is not cosmetic — Swagger UI ships no dark
    // theme, so Chrome's "Auto Dark Mode for Web Contents" decides to re-tint
    // the page itself, and does it unevenly (light background, inverted prose,
    // muddy contrast). Declaring the page light opts out of that and hands the
    // palette back to Swagger.
    //
    // Nothing else is themed on purpose. The method colours — blue GET, green
    // POST, red DELETE — are how anyone reads this page at a glance, and are
    // not ours to reinterpret. The topbar is hidden only because it is a spec
    // URL picker that would let a reader load someone else's OpenAPI document
    // into our docs page; it carries no information of its own.
    customCss: `
      :root { color-scheme: only light; }
      .swagger-ui .topbar { display: none; }
    `,
  }),
);

export default router;
