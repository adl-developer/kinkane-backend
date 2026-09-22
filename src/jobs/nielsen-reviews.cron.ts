import cron, { ScheduledTask } from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { bookReviewsService } from '../services/book-reviews.service';

/**
 * Nightly sweep for Nielsen review text, scheduled by NIELSEN_REVIEWS_CRON
 * (default 01:00). Spends only the batch half of the daily record allowance,
 * leaving the rest for on-demand lookups from book pages.
 *
 * NOTE: like the other crons here, in a multi-process cluster this runs in
 * every worker at once. That is safe rather than merely idempotent — every
 * lookup has to claim a record from nielsen_api_usage first, so duplicate
 * runs compete for one shared budget instead of multiplying it.
 */
export function startNielsenReviewsCron(): ScheduledTask {
  const task = cron.schedule(config.nielsen.cronSchedule, async () => {
    try {
      await bookReviewsService.runDailyBatch();
    } catch (err) {
      logger.error('Nielsen review batch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Nielsen reviews cron started', {
    schedule: config.nielsen.cronSchedule,
    enabled: config.nielsen.enabled,
  });
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopNielsenReviewsCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Nielsen reviews cron stopped');
}
