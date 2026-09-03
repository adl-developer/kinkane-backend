import cron, { ScheduledTask } from 'node-cron';
import { fulfilmentService } from '../services/commerce/fulfilment.service';
import { ordersService } from '../services/commerce/orders.service';
import { bestsellersService } from '../services/commerce/bestsellers.service';
import { logger } from '../lib/logger';

/**
 * How long a `pending_payment` order is left alone before being written off.
 *
 * Stripe Checkout sessions expire after 24 hours and send
 * `checkout.session.expired`, which handles the normal case. This sweep exists
 * for the abnormal one: a session that errored before the buyer ever saw it
 * produces no event at all, and without this those rows sit in
 * `pending_payment` forever.
 */
const ABANDONED_CHECKOUT_HOURS = 25;

/**
 * Runs every 30 minutes: polls Gardners for order acknowledgements, then for
 * dispatches.
 *
 * Frequent because this is the customer-visible half of fulfilment — an order
 * turning into "confirmed" and then into "on its way, here is your tracking
 * number" covers the two status changes buyers actually watch for.
 *
 * The two polls share a tick but not a fate: dispatches are collected even when
 * the ack poll throws, because they are independent files and an SFTP hiccup on
 * one directory says nothing about the other. Dispatch runs second only because
 * an order normally reaches `acknowledged` before it ships.
 *
 * NOTE: in a multi-process cluster this runs in every worker at once. Both
 * polls are idempotent — the ack status write is, and dispatch inserts are
 * arbitrated by `uq_gardners_dropship_dispatch_line` — so duplicate runs are
 * harmless. Each one opens its own SFTP session, which is why neither is
 * scheduled more aggressively than this.
 */
export function startOrderReconciliationCron(): ScheduledTask {
  const task = cron.schedule('*/30 * * * *', async () => {
    try {
      const { checked, acknowledged } = await fulfilmentService.pollAcknowledgements();
      if (acknowledged > 0) {
        logger.info('Order acknowledgement poll complete', { checked, acknowledged });
      }
    } catch (err) {
      logger.error('Order acknowledgement poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const { files, lines, ordersDispatched } = await fulfilmentService.pollDispatches();
      if (ordersDispatched > 0) {
        logger.info('Order dispatch poll complete', { files, lines, ordersDispatched });
      }
    } catch (err) {
      logger.error('Order dispatch poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await ordersService.expireStale(ABANDONED_CHECKOUT_HOURS);
    } catch (err) {
      logger.error('Abandoned checkout sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Order reconciliation cron started (every 30 minutes)');
  return task;
}

export function stopOrderReconciliationCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Order reconciliation cron stopped');
}

/**
 * Runs nightly at 04:10 and drops the cached bestseller windows.
 *
 * The chart is cached for an hour, so this is not what keeps it fresh — it is
 * what stops a *stale shape* persisting. The `7d` window in particular changes
 * meaning every day as sales age out of it, and the cheapest way to guarantee
 * the day's first reader gets a correctly-bounded window is to clear the keys
 * once the date has turned. Scheduled after the existing 03:xx cleanups so the
 * quiet window is not contended.
 */
export function startBestsellerRefreshCron(): ScheduledTask {
  const task = cron.schedule('10 4 * * *', async () => {
    try {
      await bestsellersService.invalidate();
      logger.info('Bestseller cache invalidated');
    } catch (err) {
      logger.error('Bestseller cache invalidation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('Bestseller refresh cron started (daily 04:10)');
  return task;
}

export function stopBestsellerRefreshCron(task: ScheduledTask): void {
  task.stop();
  logger.info('Bestseller refresh cron stopped');
}
