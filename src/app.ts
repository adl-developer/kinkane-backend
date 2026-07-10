import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { logger } from './lib/logger';
import { emailQueue } from './lib/email-queue';
import { pushQueue } from './lib/push-queue';
import { config } from './config';
import apiRoutes from './routes';

const app = express();

// Trust one proxy hop (Render load balancer) so req.ip reflects the real client
// IP rather than the balancer's IP — required for rate limiting to work correctly.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: [config.appUrl],
  credentials: true,
  exposedHeaders: ['X-New-Access-Token'],
}));

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
  queues: [new BullMQAdapter(emailQueue), new BullMQAdapter(pushQueue)],
  serverAdapter: bullBoardAdapter,
});
app.use('/admin/queues', requireAdminToken, bullBoardAdapter.getRouter());

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
