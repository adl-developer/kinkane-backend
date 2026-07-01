import cron, { ScheduledTask } from 'node-cron';
import pLimit from 'p-limit';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { notificationPreferences, users } from '../db/schema';
import { sendRecommendationEmail } from '../services/recommendation-notifications.service';
import { logger } from '../lib/logger';

const CADENCE_DAYS = 5;
// Process up to 10 users concurrently — enough to parallelise DB work without
// overwhelming the connection pool or the email queue.
const CONCURRENCY = 10;

// Runs at 09:00 UTC every day, but only sends to users whose last recommendation
// was sent more than CADENCE_DAYS ago (or never). Daily tick means the job never
// misses a user by more than 24 hours due to scheduling drift.
export function startRecommendationCron(): ScheduledTask {
  const task = cron.schedule('0 9 * * *', async () => {
    logger.info('Recommendation email cron started');

    try {
      const cutoff = new Date(Date.now() - CADENCE_DAYS * 24 * 60 * 60 * 1000);

      const eligibleRows = await db
        .select({
          userId: notificationPreferences.userId,
          email: users.email,
          name: users.name,
        })
        .from(notificationPreferences)
        .innerJoin(users, eq(users.id, notificationPreferences.userId))
        .where(
          and(
            eq(notificationPreferences.newBookSuggestions, true),
            or(
              isNull(notificationPreferences.lastRecommendationSentAt),
              lt(notificationPreferences.lastRecommendationSentAt, cutoff),
            ),
          ),
        );

      logger.info('Recommendation cron: eligible users', { count: eligibleRows.length });

      let sent = 0;
      let skipped = 0;

      const limit = pLimit(CONCURRENCY);

      await Promise.all(
        eligibleRows.map((row) =>
          limit(async () => {
            try {
              const didSend = await sendRecommendationEmail(row.userId, row.email, row.name);
              if (didSend) sent++;
              else skipped++;
            } catch (err) {
              logger.error('Recommendation cron: failed for user', {
                userId: row.userId,
                error: (err as Error).message,
              });
            }
          }),
        ),
      );

      logger.info('Recommendation cron complete', { sent, skipped });
    } catch (err) {
      logger.error('Recommendation cron failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info(`Recommendation email cron started (daily at 09:00 UTC, ${CADENCE_DAYS}-day cadence)`);
  return task;
}

export function stopRecommendationCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Recommendation email cron stopped');
}
