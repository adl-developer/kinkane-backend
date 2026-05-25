import express, { Request, Response, NextFunction } from 'express';
import { logger } from './lib/logger';
import apiRoutes from './routes';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
