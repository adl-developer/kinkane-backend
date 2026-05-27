import app from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { connectRedis, disconnectRedis } from './lib/redis';
import { startGuestCleanupCron, stopGuestCleanupCron } from './jobs/guest-cleanup.cron';
import { startWeeklyDigestCron, stopWeeklyDigestCron } from './jobs/weekly-digest.cron';
import { startEmailWorker, stopEmailWorker } from './workers/email.worker';
import { emailQueue, bullConnection } from './lib/email-queue';

async function main(): Promise<void> {
  await connectRedis();

  const cronTask = startGuestCleanupCron();
  const weeklyDigestTask = startWeeklyDigestCron();
  const emailWorker = startEmailWorker();

  const server = app.listen(config.port, () => {
    logger.info('kinkane-server started', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (signal: string) => {
    logger.info('Shutting down gracefully', { signal });
    stopGuestCleanupCron(cronTask);
    stopWeeklyDigestCron(weeklyDigestTask);
    // server.close() stops accepting new connections and waits for in-flight
    // requests to finish — disconnect Redis only after they drain so that any
    // in-flight cache/rate-limit call can still reach Redis.
    server.close(async () => {
      logger.info('HTTP server closed');
      await stopEmailWorker(emailWorker); // waits for the active job to finish
      await emailQueue.close();
      await bullConnection.quit();
      await disconnectRedis();
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
