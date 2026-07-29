import cron, { ScheduledTask } from 'node-cron';
import { preferenceHistoryService } from '../services/preference-history.service';
import { logger } from '../lib/logger';

/** How long a preference history row is kept before it becomes eligible for pruning. */
const RETENTION_YEARS = 2;

/**
 * Runs daily at 03:20 and deletes preference history rows older than
 * RETENTION_YEARS — except each user's most recent row, which is kept
 * regardless of age. A user who set their preferences once and never touched
 * them again must not end up with an empty timeline while their
 * `user_preferences` row still says otherwise.
 *
 * Cron expression: "20 3 * * *"  →  03:20 every day. Unlike the guest-session
 * TTL this is not time-sensitive, so once a day at a quiet hour is plenty.
 *
 * NOTE: In a multi-process cluster this job runs in every worker
 * simultaneously. The DELETE is idempotent so duplicate runs are harmless.
 */
export function startPreferenceHistoryCleanupCron(): ScheduledTask {
  const task = cron.schedule('20 3 * * *', async () => {
    try {
      const deleted = await preferenceHistoryService.pruneOlderThan(RETENTION_YEARS);

      if (deleted > 0) {
        logger.info('Preference history cleanup complete', { deleted, retentionYears: RETENTION_YEARS });
      }
    } catch (err) {
      logger.error('Preference history cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Preference history cleanup cron started (daily, 2 year retention)');
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopPreferenceHistoryCleanupCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Preference history cleanup cron stopped');
}
