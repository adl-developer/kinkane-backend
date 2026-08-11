import app from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { connectRedis, disconnectRedis } from './lib/redis';
import { startGuestCleanupCron, stopGuestCleanupCron } from './jobs/guest-cleanup.cron';
import { startWeeklyDigestCron, stopWeeklyDigestCron } from './jobs/weekly-digest.cron';
import { startRecommendationCron, stopRecommendationCron } from './jobs/recommendation.cron';
import { startTrialExpiryCron, stopTrialExpiryCron } from './jobs/trial-expiry.cron';
import {
  startSubscriptionReconciliationCron,
  stopSubscriptionReconciliationCron,
} from './jobs/subscription-reconciliation.cron';
import {
  startPreferenceHistoryCleanupCron,
  stopPreferenceHistoryCleanupCron,
} from './jobs/preference-history-cleanup.cron';
import {
  startInteractionCleanupCron,
  stopInteractionCleanupCron,
} from './jobs/interaction-cleanup.cron';
import {
  startOrderReconciliationCron,
  stopOrderReconciliationCron,
  startBestsellerRefreshCron,
  stopBestsellerRefreshCron,
} from './jobs/order-reconciliation.cron';
import { startEmailWorker, stopEmailWorker } from './workers/email.worker';
import { startFulfilmentWorker, stopFulfilmentWorker } from './workers/fulfilment.worker';
import { startPushWorker, stopPushWorker } from './workers/push.worker';
import { emailQueue, bullConnection } from './lib/email-queue';
import { pushQueue } from './lib/push-queue';
import { fulfilmentQueue } from './lib/fulfilment-queue';

async function main(): Promise<void> {
  await connectRedis();

  const cronTask = startGuestCleanupCron();
  const weeklyDigestTask = startWeeklyDigestCron();
  const recommendationCronTask = startRecommendationCron();
  const trialExpiryCronTask = startTrialExpiryCron();
  const subscriptionReconciliationTask = startSubscriptionReconciliationCron();
  const preferenceHistoryCleanupTask = startPreferenceHistoryCleanupCron();
  const interactionCleanupTask = startInteractionCleanupCron();
  const orderReconciliationTask = startOrderReconciliationCron();
  const bestsellerRefreshTask = startBestsellerRefreshCron();
  const emailWorker = startEmailWorker();
  const pushWorker = startPushWorker();
  const fulfilmentWorker = startFulfilmentWorker();

  const server = app.listen(config.port, () => {
    logger.info('kinkane-server started', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (signal: string) => {
    logger.info('Shutting down gracefully', { signal });
    stopGuestCleanupCron(cronTask);
    stopWeeklyDigestCron(weeklyDigestTask);
    stopRecommendationCron(recommendationCronTask);
    stopTrialExpiryCron(trialExpiryCronTask);
    stopSubscriptionReconciliationCron(subscriptionReconciliationTask);
    stopPreferenceHistoryCleanupCron(preferenceHistoryCleanupTask);
    stopInteractionCleanupCron(interactionCleanupTask);
    stopOrderReconciliationCron(orderReconciliationTask);
    stopBestsellerRefreshCron(bestsellerRefreshTask);
    // server.close() stops accepting new connections and waits for in-flight
    // requests to finish — disconnect Redis only after they drain so that any
    // in-flight cache/rate-limit call can still reach Redis.
    server.close(async () => {
      logger.info('HTTP server closed');
      await stopEmailWorker(emailWorker); // waits for the active job to finish
      await emailQueue.close();
      await stopPushWorker(pushWorker);
      await pushQueue.close();
      // Waits for an in-flight Gardners submission to finish: killing one
      // mid-SFTP-write would leave a partial .ORD file on their server.
      await stopFulfilmentWorker(fulfilmentWorker);
      await fulfilmentQueue.close();
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
