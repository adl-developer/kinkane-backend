import type { Request } from 'express';
import { config } from '../../config';
import { securitySchemes, schemas, responses } from './components';
import { authPaths } from './paths/auth';
import { cataloguePaths } from './paths/catalogue';
import { onboardingPaths } from './paths/onboarding';
import { libraryPaths } from './paths/library';
import { socialPaths } from './paths/social';
import { accountPaths } from './paths/account';
import { commercePaths } from './paths/commerce';
import { billingPaths } from './paths/billing';
import { referralPaths } from './paths/referrals';

/**
 * Assembles the OpenAPI 3.0 document.
 *
 * Built per-request rather than once at boot, because the `servers` entry is
 * derived from the host the request arrived on. That is what makes "Try it out"
 * hit *this* deployment — and therefore this deployment's DATABASE_URL — rather
 * than a URL baked in at build time that may belong to a different environment
 * entirely. Getting that wrong is how someone ends up writing test data into
 * production while reading a staging docs page.
 */

/**
 * Describes the database this process is actually connected to, without
 * leaking the credentials in DATABASE_URL.
 *
 * The whole point of showing it is that "Try it out" writes real rows: a reader
 * about to POST a signup needs to know *which* database gets it. Host and
 * database name answer that; user and password are stripped, and a malformed
 * URL degrades to "not parseable" rather than throwing inside a docs page.
 */
function describeDatabase(): string {
  try {
    const url = new URL(config.database.url);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    const port = url.port ? `:${url.port}` : '';
    return `\`${database}\` on \`${url.hostname}${port}\``;
  } catch {
    return '_(DATABASE_URL could not be parsed)_';
  }
}

/**
 * The origin this request came in on, so the docs point at themselves.
 *
 * Behind Render's load balancer the socket is plain HTTP, so `req.protocol`
 * only reports https because `trust proxy` is set in app.ts and
 * X-Forwarded-Proto is honoured. Host comes from the same forwarded chain.
 */
function resolveServerUrl(req: Request): string {
  const host = req.get('host');
  if (!host) return config.appUrl;
  return `${req.protocol}://${host}`;
}

const isProduction = config.nodeEnv === 'production';

function buildDescription(serverUrl: string): string {
  return [
    'The complete HTTP API behind the Kinkané reading app — accounts, the book catalogue,',
    'onboarding recommendations, shelves, the community, the shop, and subscriptions.',
    '',
    '---',
    '',
    isProduction
      ? '### ⚠️ This page is wired to live data'
      : '### This page is wired to live data',
    '',
    `Every **Try it out** button sends a real request to \`${serverUrl}\` and reads and writes`,
    `the database this deployment is configured with: ${describeDatabase()}.`,
    '',
    'There is no mock layer and no sandbox mode. A signup here creates an account, a checkout',
    'creates an order, and a delete deletes.',
    isProduction
      ? '\n**This deployment is running with `NODE_ENV=production`.** Assume anything you do here is real.'
      : `\n This deployment is running with \`NODE_ENV=${config.nodeEnv}\`.`,
    '',
    '---',
    '',
    '### Getting started',
    '',
    '1. **Get a token.** Call `POST /api/v1/auth/login` with an existing account, or',
    '   `POST /api/v1/auth/signup` to make one. Both return an `accessToken`.',
    '2. **Authorise.** Click **Authorize** at the top right and paste the `accessToken`.',
    '   Every subsequent request on this page will carry it.',
    '3. **Keep it fresh.** Access tokens last 15 minutes. Any authenticated response will',
    '   include a replacement in the `X-New-Access-Token` header once the current one is',
    '   within 5 minutes of expiring — real clients should read that header and swap it in',
    '   rather than waiting for a 401.',
    '',
    '### Conventions worth knowing before you integrate',
    '',
    '- **Money is always an integer in minor units** — `totalMinor: 3497` is $34.97. Fields',
    '  ending in `Minor` or `Cents` are never decimal.',
    '- **Two different error bodies.** `error` is a *string* for anything the server decided,',
    '  and an *object* of `field → [messages]` for anything that failed validation. A client',
    '  that assumes a string renders `[object Object]` on the first bad form submission.',
    '- **Branch on `code`, never on `error` text.** Message wording is not a contract.',
    '- **402 means "needs Kinkané Plus"**, not 403. The two are separated so a client can tell',
    '  "subscribe to do this" apart from "this is not yours" without parsing prose.',
    '- **404 often means "not yours".** Endpoints scoped to an owner return 404 rather than 403',
    '  for someone else’s resource, so ids cannot be probed for existence.',
    '- **Rate limits** are per IP, `RateLimit-*` headers are returned, and the per-endpoint',
    '  budget is documented on each operation. The blanket limit across `/api/v1` is 300',
    '  requests per 15 minutes.',
    '',
    '### Kinkané Plus gating',
    '',
    'Gating follows a "retain, read-only" rule: **creating and editing require Plus; reading,',
    'deleting and unliking never do.** A member whose subscription lapses keeps everything they',
    'built and can always tidy it up — they just cannot add more. Buying books is not gated at',
    'all, and neither are referrals.',
    '',
    `Gating is currently **${config.gatingEnabled ? 'ENABLED' : 'DISABLED'}** on this deployment`,
    `(\`GATING_ENABLED\`). ${config.gatingEnabled
      ? 'Plus-gated endpoints will return 402 for non-members.'
      : 'Every 402 documented below will pass through instead — the gate is deployed dark.'}`,
  ].join('\n');
}

const tags = [
  { name: 'Service', description: 'Liveness.' },
  {
    name: 'Authentication',
    description:
      'Accounts, sessions and tokens. Start here — almost everything else needs a token from one of these endpoints.',
  },
  {
    name: 'Catalogue',
    description: 'Books, authors and genres. Mostly public; searching does not need a token.',
  },
  {
    name: 'Discovery',
    description:
      'The three home-screen feeds. Trending is global, bestsellers are factual, personalised needs Plus.',
  },
  {
    name: 'Onboarding & Recommendations',
    description:
      'The quiz that produces a reader’s taste profile, both as a guest (before signup) and as a returning member.',
  },
  { name: 'Library', description: 'The user’s own shelf, and how their taste has changed over time.' },
  { name: 'Community', description: 'Reviews, comments and likes.' },
  { name: 'People & Following', description: 'Profiles, the follow graph, and moderation reports.' },
  { name: 'Account & Settings', description: 'Profile, privacy and account-level settings.' },
  { name: 'Notifications', description: 'The in-app feed, push registration, and email preferences.' },
  { name: 'Shop', description: 'Cart and checkout. Not gated behind Plus — buying is open to everyone.' },
  { name: 'Orders & Payments', description: 'Order history, and confirming a payment after a Stripe redirect.' },
  { name: 'Subscription', description: 'Kinkané Plus — plans, checkout, cancellation and reactivation.' },
  {
    name: 'Referrals',
    description:
      'Invite links and the "Around the World" competition. Open to every signed-up account, lapsed ones included.',
  },
];

export function buildOpenApiDocument(req: Request): Record<string, unknown> {
  const serverUrl = resolveServerUrl(req);

  return {
    openapi: '3.0.3',
    info: {
      title: 'Kinkané API',
      version: '1.0.0',
      description: buildDescription(serverUrl),
      contact: { name: 'Kinkané', url: config.appUrl },
    },
    servers: [
      {
        url: serverUrl,
        description: `This deployment (${config.nodeEnv}) — reads and writes ${describeDatabase()}.`,
      },
    ],
    tags,
    // Applied to every operation unless it opts out with `security: []`.
    security: [{ bearerAuth: [] }],
    components: { securitySchemes, schemas, responses },
    paths: {
      ...authPaths,
      ...cataloguePaths,
      ...onboardingPaths,
      ...libraryPaths,
      ...socialPaths,
      ...accountPaths,
      ...commercePaths,
      ...billingPaths,
      ...referralPaths,
    },
  };
}
