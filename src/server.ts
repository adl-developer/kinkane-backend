import app from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { startGuestCleanupCron, stopGuestCleanupCron } from './jobs/guest-cleanup.cron';

async function main(): Promise<void> {
  const cronTask = startGuestCleanupCron();

  const server = app.listen(config.port, () => {
    logger.info('kinkane-server started', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (signal: string) => {
    logger.info('Shutting down gracefully', { signal });
    stopGuestCleanupCron(cronTask);
    // process.exit must be called inside the callback — server.close() is async
    // and exits before connections drain if called outside it.
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
