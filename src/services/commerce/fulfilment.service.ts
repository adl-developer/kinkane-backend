/**
 * Handing a paid order to Gardners for dropship delivery.
 *
 * This runs **outside** the Stripe webhook, on a queue. Submitting an order is
 * an SFTP round trip to a UK server; a webhook handler that blocked on it would
 * time out, Stripe would redeliver, and payment success would end up depending
 * on whether our supplier's FTP happened to be up. Payment and fulfilment are
 * separate concerns and separate failure domains.
 *
 * What this does NOT do — inherited from the dropship module, which was built
 * to prove the order→ack cycle and nothing further:
 *   - no dispatch (.HDD) polling
 *   - no backorder (BACKORD.TXT) reconciliation
 *   - no cancellation (.CRF/.CRA)
 * A refund is therefore a manual Stripe action plus a call to Gardners. The
 * `refunded` order status exists so that manual action can at least be
 * recorded against the order.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { orders, orderItems, type Order } from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { gardnersCountryName, serviceCodeFor, supportsTracking } from './gardners-countries';
import { isDropshipSftpBlocked } from '../gardners-dropship/connection.service';
import {
  gardnersDropshipOrderService,
  type CreateOrderLineInput,
} from '../gardners-dropship/order.service';
import type { RecipientAddress } from '../gardners-dropship/order-builder';

/**
 * Gardners' EDI address fields are fixed-width `varchar(35)` and its parser is
 * a legacy fixed-format reader, not a tolerant one. Over-long values must be
 * truncated before submission rather than rejected at the far end.
 */
const EDI_FIELD_MAX = 35;
const EDI_POSTCODE_MAX = 8;

function truncate(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Country names and delivery service codes both come from
 * `gardners-countries.ts`, which documents how much of that table is actually
 * verified — very little, because the authoritative "I12d FTP Country List.txt"
 * is not in the specification PDF and has to be requested from Gardners.
 */

export class FulfilmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FulfilmentError';
  }
}

/**
 * Builds the Gardners address block from an order, failing loudly on anything
 * the EDI format cannot carry.
 *
 * Exported so checkout can dry-run it *before* taking payment — validating
 * after the money has moved means refunding an order we were never able to
 * ship.
 */
export function buildRecipientAddress(order: Order): RecipientAddress {
  const country = gardnersCountryName(order.shippingCountryCode);

  if (!country) {
    // Checkout refuses unmappable destinations before taking payment, so
    // reaching this at fulfilment time means the mapping was narrowed after the
    // order was placed. The order stays paid and an operator has to widen it.
    throw new FulfilmentError(
      `No Gardners country name mapped for ${order.shippingCountryCode} — ` +
        'add it to GARDNERS_COUNTRY_NAMES_EXTRA',
    );
  }

  const name = truncate(order.shippingName, EDI_FIELD_MAX);
  const addr1 = truncate(order.shippingLine1, EDI_FIELD_MAX);

  if (!name || !addr1) {
    throw new FulfilmentError('Order has no usable delivery name or first address line');
  }

  return {
    name,
    addr1,
    addr2: truncate(order.shippingLine2, EDI_FIELD_MAX),
    addr3: truncate(order.shippingCity, EDI_FIELD_MAX),
    addr4: truncate(order.shippingRegion, EDI_FIELD_MAX),
    postcode: truncate(order.shippingPostcode, EDI_POSTCODE_MAX),
    country,
  };
}

export const fulfilmentService = {
  /**
   * Submits a paid order to Gardners.
   *
   * Idempotent on `gardners_dropship_order_id`: a redelivered webhook or a
   * retried job must never place the same order twice, which at this end of the
   * pipeline means shipping and paying for duplicate books.
   */
  async submit(orderId: number): Promise<void> {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);

    if (!order) {
      throw new FulfilmentError(`Order ${orderId} not found`);
    }

    if (order.gardnersDropshipOrderId) {
      logger.info('Order already submitted to supplier — skipping', {
        orderId,
        gardnersDropshipOrderId: order.gardnersDropshipOrderId,
      });
      return;
    }

    if (order.status !== 'paid') {
      logger.warn('Refusing to fulfil an order that is not paid', {
        orderId,
        status: order.status,
      });
      return;
    }

    // In development nothing is sent to Gardners. Returning rather than
    // throwing is the point: a throw would burn all six queue retries and then
    // sit in Bull Board looking like a real failure, on every local checkout.
    // The order stays `paid` — which is the truth, since it is genuinely
    // awaiting fulfilment — with a note saying why nothing was submitted.
    if (isDropshipSftpBlocked()) {
      logger.warn('Skipping Gardners submission: NODE_ENV is development', {
        orderId,
        hint: 'Set GARDNERS_DROPSHIP_ALLOW_IN_DEV=true only to send real traffic to the supplier',
      });

      await db
        .update(orders)
        .set({
          fulfilmentErrorMessage:
            'Not submitted: Gardners is disabled in development (GARDNERS_DROPSHIP_ALLOW_IN_DEV=false)',
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));

      return;
    }

    // Claim the order before talking to Gardners.
    //
    // The checks above are a fast path; this single conditional UPDATE is what
    // actually prevents a duplicate submission. Two workers — two instances, or
    // a retried job overlapping the original — would otherwise both read `paid`
    // with no dropship id and both send the order, and at this end of the
    // pipeline a duplicate means shipping and paying for the same books twice.
    //
    // The claim moves the order to `submitted_to_supplier` *before* the send
    // rather than after. That is deliberate: a crash mid-send leaves the order
    // visibly in flight rather than looking like it still needs sending. The
    // catch below releases the claim when the send genuinely failed, so a retry
    // can pick it up.
    const claimed = await db
      .update(orders)
      .set({ status: 'submitted_to_supplier', updatedAt: new Date() })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.status, 'paid'),
          isNull(orders.gardnersDropshipOrderId),
        ),
      )
      .returning({ id: orders.id });

    if (claimed.length === 0) {
      logger.info('Another worker already claimed this order for fulfilment — skipping', {
        orderId,
      });
      return;
    }

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));

    try {
      const address = buildRecipientAddress(order);
      // What the buyer actually paid for, when the order recorded it. Falling
      // back to the country rule covers orders placed before delivery options
      // existed, and any order priced from the flat rate table.
      //
      // Never re-derived when a code is present: the buyer chose and paid for a
      // specific service, and shipping them something different because a
      // default changed is a promise broken after the money moved.
      const serviceCode = order.shippingServiceCode ?? serviceCodeFor(order.shippingCountryCode);

      // Shipping is charged once per order but Gardners bills per line, so the
      // whole delivery amount rides on the first line and the rest carry zero.
      // Splitting it across lines would round badly and make the total we were
      // invoiced disagree with the total we charged.
      const lines: CreateOrderLineInput[] = items.map((item, index) => ({
        isbn13: item.isbn13,
        quantity: item.quantity,
        additionalReference: `KK${order.id}`,
        priceGbpPence: item.unitPriceGbpPence,
        deliveryGbpPence: index === 0 ? order.shippingGbpPence : 0,
        serviceCode,
        tracking: supportsTracking(serviceCode),
        trackingEmail: order.contactEmail,
        // Gardners' SMS tracking field. Only populated when the buyer gave a
        // number — an empty string is what the spec's own example sends when
        // there is none, and `trackingSms` serialises to exactly that.
        ...(order.contactPhone && { trackingSms: order.contactPhone }),
        invoice: address,
        comm1: `Kinkane order ${order.id}`,
      }));

      const result = await gardnersDropshipOrderService.createAndSubmit({
        testing: config.gardnersDropship.defaultTesting,
        lines,
      });

      // Status was already set by the claim; this records which supplier order
      // it became, which is what makes the skip above work on a later retry.
      await db
        .update(orders)
        .set({
          gardnersDropshipOrderId: result.order.id,
          fulfilmentErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));

      logger.info('Order submitted to Gardners', {
        orderId,
        gardnersDropshipOrderId: result.order.id,
        testing: result.order.testing,
        lineCount: lines.length,
      });
    } catch (err) {
      const message = (err as Error).message;

      // Release the claim by putting the order back to `paid`, and record why.
      //
      // `paid` is the honest state: the customer has been charged and is owed
      // their books. Leaving it claimed would hide it from every retry and make
      // it look resolved, and moving it to a failure state would do the same.
      // An operator needs to see a paid order carrying an error — which is
      // exactly what the console's needs_attention tab surfaces.
      await db
        .update(orders)
        .set({
          status: 'paid',
          fulfilmentErrorMessage: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));

      logger.error('Failed to submit order to Gardners', { orderId, error: message });
      throw err;
    }
  },

  /**
   * Collects Gardners' dispatch files and puts tracking on the customer's order.
   *
   * This is the step that makes `carrier`, `trackingNumber`, `trackingUrl` and
   * `dispatchedAt` non-null — until it runs, an order sits at `acknowledged`
   * with an empty tracking block however long ago it actually shipped.
   *
   * Driven by a cron, like the ack poll, because Gardners writes dispatch files
   * on its own schedule: "at present once daily, usually around late evening",
   * with the spec explicitly reserving the right to change both frequency and
   * timing.
   */
  async pollDispatches(): Promise<{ files: number; lines: number; ordersDispatched: number }> {
    // Same absolute as the ack poll: nothing reaches Gardners in development.
    if (isDropshipSftpBlocked()) {
      return { files: 0, lines: 0, ordersDispatched: 0 };
    }

    const outcome = await gardnersDropshipOrderService.pollDispatches();
    if (outcome.dispatched.length === 0) {
      return { files: outcome.filesProcessed, lines: 0, ordersDispatched: 0 };
    }

    // One dispatch file can carry lines from several of our orders, and one
    // order's lines can arrive across several files. Group by dropship order so
    // each customer order is touched once per run.
    const byDropshipOrder = new Map<number, typeof outcome.dispatched>();
    for (const line of outcome.dispatched) {
      const list = byDropshipOrder.get(line.dropshipOrderId) ?? [];
      list.push(line);
      byDropshipOrder.set(line.dropshipOrderId, list);
    }

    let ordersDispatched = 0;

    for (const [dropshipOrderId, lines] of byDropshipOrder) {
      try {
        const applied = await this.applyDispatchToOrder(dropshipOrderId, lines);
        if (applied) ordersDispatched += 1;
      } catch (err) {
        // One order failing to update must not lose the dispatch rows already
        // written for the others — those are the durable record, and the next
        // poll will not re-read a deleted file.
        logger.error('Failed to apply dispatch to order', {
          dropshipOrderId,
          error: (err as Error).message,
        });
      }
    }

    return { files: outcome.filesProcessed, lines: outcome.dispatched.length, ordersDispatched };
  },

  /**
   * Puts one dropship order's dispatch details onto the customer order.
   *
   * **Which tracking wins, when a parcel splits.** An order can ship as several
   * parcels with different tracking numbers, and `orders` has room for exactly
   * one. This takes the first dispatch that actually carries a tracking number,
   * on the reasoning that the customer's "track my parcel" link should be
   * stable — a link that changes each time another box ships is worse than one
   * that points at the first. Every parcel is recorded in full on
   * `gardners_dropship_dispatches`, so nothing is lost, and a future
   * multi-parcel UI reads from there.
   *
   * Only ever moves an order *forward*: an order already `delivered` or
   * `refunded` is left alone, so a late-arriving dispatch file cannot walk a
   * finished order backwards into `dispatched`.
   */
  async applyDispatchToOrder(
    dropshipOrderId: number,
    lines: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; dispatchedOn: string | null }[],
  ): Promise<boolean> {
    const [order] = await db
      .select({ id: orders.id, trackingNumber: orders.trackingNumber })
      .from(orders)
      .where(eq(orders.gardnersDropshipOrderId, dropshipOrderId))
      .limit(1);

    if (!order) {
      logger.warn('Dispatch for a dropship order with no customer order', { dropshipOrderId });
      return false;
    }

    const withTracking = lines.find((line) => line.trackingNumber) ?? lines[0];

    // Earliest dispatch date across this batch — when the order started
    // shipping, not when the last box did.
    const dates = lines.map((l) => l.dispatchedOn).filter((d): d is string => d !== null).sort();
    const dispatchedAt = dates.length > 0 ? new Date(`${dates[0]}T00:00:00.000Z`) : new Date();

    const result = await db
      .update(orders)
      .set({
        status: 'dispatched',
        // Never overwrite tracking already on the order — the first parcel's
        // link stays the customer's link.
        ...(order.trackingNumber
          ? {}
          : {
              carrier: withTracking.carrier,
              trackingNumber: withTracking.trackingNumber,
              trackingUrl: withTracking.trackingUrl,
            }),
        dispatchedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orders.id, order.id),
          // Forward-only. `paid` is included because a dispatch can plausibly
          // land before the ack poll has caught up.
          inArray(orders.status, ['paid', 'submitted_to_supplier', 'acknowledged', 'dispatched']),
        ),
      )
      .returning({ id: orders.id });

    if (result.length === 0) return false;

    logger.info('Order dispatched', {
      orderId: order.id,
      carrier: withTracking.carrier,
      hasTracking: Boolean(withTracking.trackingNumber),
    });
    return true;
  },

  /**
   * Polls Gardners for acknowledgements on everything submitted but not yet
   * acknowledged. Driven by a cron — Gardners writes the .ACK on its own
   * schedule, so there is nothing to wait on synchronously.
   */
  async pollAcknowledgements(): Promise<{ checked: number; acknowledged: number }> {
    // Polling is a read, but it is still a connection to the supplier's server,
    // and "nothing reaches Gardners in development" is easier to reason about
    // as an absolute than as a rule with a read-only exception.
    if (isDropshipSftpBlocked()) {
      return { checked: 0, acknowledged: 0 };
    }

    const pending = await db
      .select({ id: orders.id, dropshipId: orders.gardnersDropshipOrderId })
      .from(orders)
      .where(eq(orders.status, 'submitted_to_supplier'));

    let acknowledged = 0;

    for (const row of pending) {
      if (!row.dropshipId) continue;

      try {
        const outcome = await gardnersDropshipOrderService.pollAck(row.dropshipId);
        if (outcome.status === 'not_ready') continue;

        // A rejected header means Gardners threw the whole file away. An
        // acknowledgement that fulfilled nothing is the same outcome by a
        // different route — the customer has paid and is getting no books
        // either way, and both need an operator to look at them.
        const status =
          outcome.status === 'header_rejected' ||
          (outcome.status === 'acknowledged' && outcome.fulfilled === 0 && outcome.rejected > 0)
            ? 'supplier_rejected'
            : 'acknowledged';

        await db
          .update(orders)
          .set({ status, updatedAt: new Date() })
          .where(eq(orders.id, row.id));

        acknowledged += 1;
        logger.info('Order acknowledgement reconciled', { orderId: row.id, status });
      } catch (err) {
        // One unreachable ack must not stop the rest of the batch.
        logger.error('Failed to poll acknowledgement', {
          orderId: row.id,
          error: (err as Error).message,
        });
      }
    }

    return { checked: pending.length, acknowledged };
  },
};
