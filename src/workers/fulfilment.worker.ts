import { Worker, Job } from 'bullmq';
import { bullConnection } from '../lib/email-queue';
import { FULFILMENT_JOB, type FulfilmentJobData } from '../lib/fulfilment-queue';
import { fulfilmentService } from '../services/commerce/fulfilment.service';
import { logger } from '../lib/logger';

/**
 * Submits paid orders to Gardners.
 *
 * **Concurrency is 1, deliberately.** Every job opens an SFTP session to the
 * same Home Delivery account and writes a file into the same directory;
 * Gardners' end is a legacy system with no stated concurrency guarantees, and
 * the cost of getting this wrong is duplicated or interleaved order files.
 * Throughput is not the constraint here — this queue handles one job per order,
 * not per request.
 */
async function processFulfilmentJob(job: Job<FulfilmentJobData>): Promise<void> {
  if (job.name !== FULFILMENT_JOB) {
    logger.warn('Unknown fulfilment job name — ignoring', { jobName: job.name, jobId: job.id });
    return;
  }

  await fulfilmentService.submit(job.data.orderId);
}

export function startFulfilmentWorker(): Worker {
  const worker = new Worker('fulfilment', processFulfilmentJob, {
    connection: bullConnection,
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    const exhausted = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);

    // A job that has run out of retries is a customer who has paid and whose
    // order has not reached the supplier. That is not a routine failure and it
    // should not read like one in the logs.
    logger.error(exhausted ? 'Order fulfilment permanently failed' : 'Order fulfilment attempt failed', {
      jobId: job?.id,
      orderId: (job?.data as FulfilmentJobData | undefined)?.orderId,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
      needsManualIntervention: exhausted,
      error: err.message,
    });
  });

  logger.info('Fulfilment worker started', { concurrency: 1 });
  return worker;
}

export async function stopFulfilmentWorker(worker: Worker): Promise<void> {
  await worker.close();
  logger.info('Fulfilment worker stopped');
}
