import cron, { ScheduledTask } from 'node-cron';
import { lt } from 'drizzle-orm';
import { db } from '../db';
import { guestSessions } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * Runs every 6 hours and hard-deletes guest session rows whose expiresAt
 * has passed. The TTL is controlled by GUEST_SESSION_TTL_HOURS in config.
 *
 * Cron expression: "0 *\/6 * * *"  →  at minute 0 of every 6th hour.
 *
 * NOTE: In a multi-process cluster (e.g. PM2 cluster mode) this job runs in
 * every worker simultaneously. The DELETE is idempotent so duplicate runs are
 * harmless, but if you want to avoid the redundancy consider running cleanup
 * only in the primary process or via a dedicated queue worker.
 */
export function startGuestCleanupCron(): ScheduledTask {
  const task = cron.schedule('0 */6 * * *', async () => {
    try {
      const deleted = await db
        .delete(guestSessions)
        .where(lt(guestSessions.expiresAt, new Date()))
        .returning({ id: guestSessions.id });

      if (deleted.length > 0) {
        logger.info('Guest session cleanup complete', { deleted: deleted.length });
      }
    } catch (err) {
      logger.error('Guest session cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Guest session cleanup cron started (every 6 hours)');
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopGuestCleanupCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Guest session cleanup cron stopped');
}
