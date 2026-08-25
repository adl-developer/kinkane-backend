import { Queue } from 'bullmq';
import { bullConnection } from './email-queue';
import { logger } from './logger';

/**
 * The queue that carries a paid order out to Gardners.
 *
 * Separate from the email queue because the failure profiles have nothing in
 * common: an email that never sends is an annoyance, while an order that never
 * reaches the supplier is a customer who paid for books that will never arrive.
 * That difference is why the retry policy here is far more patient — six
 * attempts backing off from 30s reaches roughly 16 minutes, which comfortably
 * outlasts a brief SFTP outage at the far end.
 *
 * Failed jobs are retained in bulk (`removeOnFail: 1000`) precisely because
 * each one is a paid order awaiting manual attention, and Bull Board is where
 * an operator will go looking for them.
 */
export const fulfilmentQueue = new Queue('fulfilment', {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 1000 },
  },
});

export interface FulfilmentJobData {
  orderId: number;
}

export const FULFILMENT_JOB = 'submit-order';

/**
 * Queues an order for supplier submission.
 *
 * Fire-and-forget by design: this is called from the Stripe webhook, where the
 * payment has already succeeded. If Redis is momentarily unreachable, the right
 * outcome is a logged error and a 200 back to Stripe — returning an error would
 * make Stripe redeliver an event whose payment side is already recorded, and
 * the order is still visible as `paid` with no supplier reference for an
 * operator (or the reconciliation sweep) to pick up.
 *
 * `jobId` is the order id, so BullMQ itself deduplicates a redelivered webhook.
 */
export function enqueueFulfilment(orderId: number): void {
  void fulfilmentQueue
    .add(FULFILMENT_JOB, { orderId }, { jobId: `order-${orderId}` })
    .catch((err: unknown) => {
      logger.error('Failed to enqueue fulfilment — order is paid but not submitted', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
