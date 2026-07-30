import cron, { ScheduledTask } from 'node-cron';
import { interactionsService } from '../services/interactions.service';
import { logger } from '../lib/logger';

/**
 * How long an interaction row is kept before it becomes eligible for pruning.
 *
 * The only query that reads this table looks back 30 days, so anything older is
 * already invisible to the product. 180 days is a deliberate margin: it leaves
 * roughly half a year of behavioural history available for tuning the weights or
 * for future recommendation work, without letting the table grow without bound.
 * Now that page views are recorded, this is the fastest-growing table we have.
 */
const RETENTION_DAYS = 180;

/**
 * Runs daily at 03:40 and deletes interaction rows older than RETENTION_DAYS.
 *
 * Cron expression: "40 3 * * *" → 03:40 every day. Scheduled 20 minutes after the
 * preference-history cleanup so the two large DELETEs don't contend for the same
 * quiet window.
 *
 * NOTE: In a multi-process cluster this job runs in every worker simultaneously.
 * The DELETE is idempotent so duplicate runs are harmless.
 */
export function startInteractionCleanupCron(): ScheduledTask {
  const task = cron.schedule('40 3 * * *', async () => {
    try {
      const deleted = await interactionsService.pruneOlderThan(RETENTION_DAYS);

      if (deleted > 0) {
        logger.info('Interaction cleanup complete', { deleted, retentionDays: RETENTION_DAYS });
      }
    } catch (err) {
      logger.error('Interaction cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Interaction cleanup cron started (daily, 180 day retention)');
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopInteractionCleanupCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Interaction cleanup cron stopped');
}
