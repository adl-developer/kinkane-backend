import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { logger } from './lib/logger';
import { emailQueue } from './lib/email-queue';
import { pushQueue } from './lib/push-queue';
import { fulfilmentQueue } from './lib/fulfilment-queue';
import { config } from './config';
import apiRoutes from './routes';
import gardnersDropshipRoutes from './routes/gardners-dropship.routes';
import referralRedirectRoutes from './routes/referral-redirect.routes';
import adminReferralsRoutes from './routes/admin-referrals.routes';
import adminConsoleRoutes from './routes/admin';
import { referralsController } from './controllers/referrals.controller';
import { wrap } from './lib/route-helpers';
import { webhookRouter as stripeWebhookRouter } from './routes/subscriptions.routes';
import docsRoutes from './routes/docs.routes';

const app = express();

// Trust one proxy hop (Render load balancer) so req.ip reflects the real client
// IP rather than the balancer's IP — required for rate limiting to work correctly.
app.set('trust proxy', 1);

app.use(helmet());
// In development, accept any origin so local clients (Expo, LAN devices,
// alternate ports) can call the API without APP_URL churn.
app.use(cors({
  origin: config.nodeEnv === 'development' ? '*' : [config.appUrl],
  credentials: true,
  exposedHeaders: ['X-New-Access-Token'],
}));

// ── Stripe webhook ────────────────────────────────────────────────────────────
// Mounted before express.json on purpose: Stripe signs the exact bytes it sends,
// so the signature can only be verified against an unparsed body. The route's
// own express.raw parser handles it. Unauthenticated by design — the signature
// is the authentication — and outside the API rate limiter, since Stripe's
// delivery volume is not abuse.
app.use('/api/v1/user/subscription/webhook', stripeWebhookRouter);

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// ── Bull Board ────────────────────────────────────────────────────────────────
// Visual dashboard for monitoring email/push job queues — view pending, active,
// completed and failed jobs at /admin/queues.
// Protected by a static bearer token (ADMIN_TOKEN env var).
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.slice(7) !== config.adminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const bullBoardAdapter = new ExpressAdapter();
bullBoardAdapter.setBasePath('/admin/queues');
createBullBoard({
  // Fulfilment is here for a different reason than the other two: a failed job
  // on this queue is a paid order that never reached the supplier, and this
  // dashboard is where an operator will go to find and retry it.
  queues: [
    new BullMQAdapter(emailQueue),
    new BullMQAdapter(pushQueue),
    new BullMQAdapter(fulfilmentQueue),
  ],
  serverAdapter: bullBoardAdapter,
});
app.use('/admin/queues', requireAdminToken, bullBoardAdapter.getRouter());

// ── Gardners dropship (I12 Home Delivery) ─────────────────────────────────────
// Admin-only surface for submitting/polling wholesale fulfillment orders —
// not part of the customer-facing checkout flow yet, so it isn't versioned
// under /api/v1. Protected by the same static bearer token as Bull Board.
app.use('/admin/gardners/dropship', requireAdminToken, gardnersDropshipRoutes);

// ── Admin console ─────────────────────────────────────────────────────────────
// The staffed console: dashboard, orders, customers, reports, settings. Guarded
// by a per-person session (see middleware/admin-auth), NOT the static token the
// machine-facing surfaces above use — these endpoints can blacklist a customer
// and export the customer list.
app.use('/admin/console', adminConsoleRoutes);

// ── Referral competition admin ────────────────────────────────────────────────
// The map, the standings, and the corrections. Same static bearer token as the
// surfaces above.
app.use('/admin/referrals', requireAdminToken, adminReferralsRoutes);
app.patch('/admin/users/:id/country', requireAdminToken, wrap(referralsController.adminSetCountry));

// ── Referral links ────────────────────────────────────────────────────────────
// Mounted at the root, above /api, because /r/CODE/name is a link a person sends
// over WhatsApp — putting /api/v1 in the middle of it would be absurd. Also the
// path registered as the universal/app link, so an installed app opens straight
// through with the code.
app.use('/r', referralRedirectRoutes);

// ── API documentation ─────────────────────────────────────────────────────────
// Interactive OpenAPI reference at /docs, behind a password (SWAGGER_PASSWORD).
//
// Mounted only when that password is set. That is the security control rather
// than an optimisation: this page executes real requests against the database
// this process is configured with, so a deployment that never chose a password
// should not publish a browsable, executable map of the entire API. Unset means
// /docs simply 404s along with everything else.
//
// Outside the /api rate limiter by design — a docs page loads dozens of static
// assets and would exhaust an API budget on its own.
if (config.swagger.enabled) {
  app.use('/docs', docsRoutes);
  logger.info('API documentation mounted at /docs');
} else {
  logger.info('SWAGGER_PASSWORD not set — API documentation is disabled');
}

app.use('/api', apiRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // body-parser throws a SyntaxError with a `body` property when the request
  // body is not valid JSON — this is a client mistake, not a server fault.
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn('Malformed JSON in request body', { error: err.message });
    res.status(400).json({ error: 'Request body contains invalid JSON' });
    return;
  }

  logger.error('Unhandled express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
