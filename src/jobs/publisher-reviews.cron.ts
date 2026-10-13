import cron, { ScheduledTask } from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { publisherReviewsService } from '../services/publisher-reviews.service';

/**
 * Nightly publisher-review pass, scheduled by PUBLISHER_REVIEWS_CRON (default
 * 04:00, after the Nielsen and BDS jobs). Re-extracts reviews for books whose
 * long description changed since the last run.
 *
 * Like the other crons this fires in every worker of a cluster; the service
 * takes a Redis lock so only one of them does the work.
 */
export function startPublisherReviewsCron(): ScheduledTask {
  const task = cron.schedule(config.publisherReviews.cronSchedule, async () => {
    try {
      await publisherReviewsService.runNightly();
    } catch (err) {
      logger.error('Publisher reviews nightly run failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Publisher reviews cron started', {
    schedule: config.publisherReviews.cronSchedule,
    enabled: config.publisherReviews.enabled,
  });
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopPublisherReviewsCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Publisher reviews cron stopped');
}
