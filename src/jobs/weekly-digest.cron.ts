import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../lib/logger';
import { enqueueEmail } from '../lib/email-queue';

/**
 * Runs every Monday at 8:00 AM UTC and sends a weekly reading digest
 * to all active users.
 *
 * Cron expression: "0 8 * * 1"  →  08:00 every Monday.
 *
 * TODO: Query active users from the DB and build each user's digest payload.
 * Stub kept intentionally minimal until the user activity queries are ready.
 */
export function startWeeklyDigestCron(): ScheduledTask {
  const task = cron.schedule('0 8 * * 1', async () => {
    logger.info('Weekly digest cron started');

    try {
      // TODO: Replace stub with real query
      // const activeUsers = await db.select(...).from(users).where(...);
      // for (const user of activeUsers) {
      //   await enqueueEmail('weekly-digest', {
      //     to: user.email,
      //     payload: {
      //       name: user.name,
      //       booksRead: ...,
      //       topGenre: ...,
      //       newRecommendationsCount: ...,
      //     },
      //   }).catch((err) =>
      //     logger.error('Failed to enqueue weekly digest', { userId: user.id, error: err.message }),
      //   );
      // }

      logger.info('Weekly digest cron complete');
    } catch (err) {
      logger.error('Weekly digest cron failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Weekly digest cron started (Mondays at 08:00 UTC)');
  return task;
}

export function stopWeeklyDigestCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Weekly digest cron stopped');
}
