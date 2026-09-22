import cron, { ScheduledTask } from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { bdsEnrichmentService } from '../services/bds-enrichment.service';

/**
 * Nightly BDS pass, scheduled by BDS_ENRICHMENT_CRON (default 02:30, after
 * Nielsen's 01:00 so the two never compete for the database). Applies
 * yesterday's changes at BDS, then sweeps books not yet looked up.
 *
 * Like the other crons this fires in every worker of a cluster; the service
 * takes a Redis lock so only one of them does the work.
 */
export function startBdsEnrichmentCron(): ScheduledTask {
  const task = cron.schedule(config.bds.cronSchedule, async () => {
    try {
      await bdsEnrichmentService.runNightly();
    } catch (err) {
      logger.error('BDS nightly enrichment failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('BDS enrichment cron started', {
    schedule: config.bds.cronSchedule,
    enabled: config.bds.enabled,
  });
  return task;
}

/** Stops the cron task cleanly on server shutdown. */
export function stopBdsEnrichmentCron(task: ScheduledTask): void {
  task.stop();
  logger.info('BDS enrichment cron stopped');
}
