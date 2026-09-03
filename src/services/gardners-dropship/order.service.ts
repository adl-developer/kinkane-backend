/**
 * Orchestrates the Gardners I12 Home Delivery (dropship) order → ack cycle:
 * persist an order + lines, build and upload the .ORD file to HOMEORD, then
 * poll HOMEACK for the matching .ACK (gated on Gardners' `.DONE` sentinel,
 * same convention onix_ingester's feed fetcher uses) and reconcile it back
 * onto the DB rows.
 *
 * Dispatch (.HDD) polling is now included — see `pollDispatches` — which is
 * what turns an acknowledged order into a tracked one.
 *
 * Still out of scope: backorder (BACKORD.TXT) reconciliation, cancellation
 * (.CRF/.CRA), and ASN invoice ingestion. Those are separate, later pieces of
 * the same I12 cycle (see the spec).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  gardnersDropshipOrders,
  gardnersDropshipOrderLines,
  gardnersDropshipDispatches,
  type GardnersDropshipOrder,
  type GardnersDropshipOrderLine,
} from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { withDropshipSftp, HOME_DELIVERY_DIRS } from './connection.service';
import { buildOrderFile, type RecipientAddress } from './order-builder';
import { parseAckFile } from './ack-parser';
import { parseHddFile, type HddDispatchLine } from './hdd-parser';

export interface CreateOrderLineInput {
  isbn13: string;
  quantity: number;
  additionalReference?: string;
  priceGbpPence: number;
  deliveryGbpPence?: number;
  serviceCode?: string; // default '011' (Overseas Airmail Tracked)
  tracking?: boolean; // default true
  trackingEmail: string; // mandatory per spec even when tracking is off
  trackingSms?: string;
  trackingSafePlace?: string;
  comm1?: string;
  invoice: RecipientAddress;
  delivery?: RecipientAddress; // omit => Gardners ships to the invoice address
  batchRef?: string; // default: shared per-order so all lines ship together
  maxWaitDays?: number;
}

export interface CreateOrderInput {
  testing?: boolean; // default: config.gardnersDropship.defaultTesting
  lines: CreateOrderLineInput[];
}

export interface OrderWithLines {
  order: GardnersDropshipOrder;
  lines: GardnersDropshipOrderLine[];
}

/** Converts Gardners' DD/MM/YYYY date fields to the ISO format our `date` columns expect. */
function toIsoDate(ddmmyyyy: string | null): string | null {
  if (!ddmmyyyy) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function generateFileStem(): string {
  // Hex timestamp: unique, monotonically increasing, and satisfies the
  // spec's "numeric order number, hex allowed" requirement without a shared
  // counter across processes. Doubles as the HEADER SEQUENCE value too.
  return Date.now().toString(16).toUpperCase();
}

async function createOrder(input: CreateOrderInput): Promise<OrderWithLines> {
  if (input.lines.length === 0) {
    throw new Error('Order must have at least one line');
  }

  const fileStem = generateFileStem();
  const testing = input.testing ?? config.gardnersDropship.defaultTesting;

  return db.transaction(async (tx) => {
    const [order] = await tx
      .insert(gardnersDropshipOrders)
      .values({
        fileStem,
        accountCode: requireAccountCode(),
        testing,
        orderDate: new Date().toISOString().slice(0, 10),
        status: 'pending_submission',
      })
      .returning();

    const lines: GardnersDropshipOrderLine[] = [];
    for (const line of input.lines) {
      const [row] = await tx
        .insert(gardnersDropshipOrderLines)
        .values({
          orderId: order.id,
          isbn13: line.isbn13,
          additionalReference: line.additionalReference ?? line.isbn13,
          quantity: line.quantity,
          priceGbpPence: line.priceGbpPence,
          deliveryGbpPence: line.deliveryGbpPence ?? 0,
          serviceCode: (line.serviceCode ?? '011').padStart(3, '0'),
          tracking: line.tracking ?? true,
          trackingEmail: line.trackingEmail,
          trackingSms: line.trackingSms ?? null,
          trackingSafePlace: line.trackingSafePlace ?? null,
          batchRef: line.batchRef ?? fileStem,
          maxWaitDays: line.maxWaitDays ?? 7,
          comm1: line.comm1 ?? null,
          invoiceTitleName: line.invoice.titleName ?? null,
          invoiceInitials: line.invoice.initials ?? null,
          invoiceName: line.invoice.name,
          invoiceAddr1: line.invoice.addr1,
          invoiceAddr2: line.invoice.addr2 ?? null,
          invoiceAddr3: line.invoice.addr3 ?? null,
          invoiceAddr4: line.invoice.addr4 ?? null,
          invoicePostcode: line.invoice.postcode ?? null,
          invoiceCountry: line.invoice.country,
          deliveryTitleName: line.delivery?.titleName ?? null,
          deliveryInitials: line.delivery?.initials ?? null,
          deliveryName: line.delivery?.name ?? null,
          deliveryAddr1: line.delivery?.addr1 ?? null,
          deliveryAddr2: line.delivery?.addr2 ?? null,
          deliveryAddr3: line.delivery?.addr3 ?? null,
          deliveryAddr4: line.delivery?.addr4 ?? null,
          deliveryPostcode: line.delivery?.postcode ?? null,
          deliveryCountry: line.delivery?.country ?? null,
          status: 'pending',
        })
        .returning();
      lines.push(row);
    }

    return { order, lines };
  });
}

function requireAccountCode(): string {
  const code = config.gardnersDropship.accountCode;
  if (!code) {
    throw new Error('GARDNERS_DROPSHIP_ACCOUNT_CODE is not configured');
  }
  return code;
}

async function getOrder(orderId: number): Promise<OrderWithLines> {
  const [order] = await db.select().from(gardnersDropshipOrders).where(eq(gardnersDropshipOrders.id, orderId));
  if (!order) throw new Error(`Gardners dropship order ${orderId} not found`);
  const lines = await db
    .select()
    .from(gardnersDropshipOrderLines)
    .where(eq(gardnersDropshipOrderLines.orderId, orderId));
  return { order, lines };
}

/** Submits a pending order's .ORD file to HOMEORD. */
async function submitOrder(orderId: number): Promise<void> {
  const { order, lines } = await getOrder(orderId);
  if (order.status !== 'pending_submission') {
    throw new Error(`Order ${orderId} is not pending submission (status=${order.status})`);
  }

  const content = buildOrderFile({
    accountCode: order.accountCode,
    orderDate: new Date(order.orderDate),
    testing: order.testing,
    sequence: order.fileStem,
    lines: lines.map((line) => ({
      uniqueReference: String(line.id).padStart(9, '0'),
      additionalReference: line.additionalReference,
      isbn13: line.isbn13,
      quantity: line.quantity,
      gardnersRefToQuote: 0,
      invoice: {
        titleName: line.invoiceTitleName ?? undefined,
        initials: line.invoiceInitials ?? undefined,
        name: line.invoiceName,
        addr1: line.invoiceAddr1,
        addr2: line.invoiceAddr2 ?? undefined,
        addr3: line.invoiceAddr3 ?? undefined,
        addr4: line.invoiceAddr4 ?? undefined,
        postcode: line.invoicePostcode ?? undefined,
        country: line.invoiceCountry,
      },
      delivery: line.deliveryName
        ? {
            titleName: line.deliveryTitleName ?? undefined,
            initials: line.deliveryInitials ?? undefined,
            name: line.deliveryName,
            addr1: line.deliveryAddr1 ?? '',
            addr2: line.deliveryAddr2 ?? undefined,
            addr3: line.deliveryAddr3 ?? undefined,
            addr4: line.deliveryAddr4 ?? undefined,
            postcode: line.deliveryPostcode ?? undefined,
            country: line.deliveryCountry ?? '',
          }
        : null,
      priceGbpPence: line.priceGbpPence,
      deliveryGbpPence: line.deliveryGbpPence,
      serviceCode: line.serviceCode,
      tracking: line.tracking,
      trackingEmail: line.trackingEmail,
      trackingSms: line.trackingSms,
      trackingSafePlace: line.trackingSafePlace,
      batchRef: line.batchRef,
      maxWaitDays: line.maxWaitDays,
      comm1: line.comm1,
    })),
  });

  const remotePath = `${HOME_DELIVERY_DIRS.order}/${order.fileStem}.ORD`;

  try {
    await withDropshipSftp((client) => client.put(Buffer.from(content, 'ascii'), remotePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(gardnersDropshipOrders)
      .set({ status: 'submission_failed', errorMessage: message })
      .where(eq(gardnersDropshipOrders.id, orderId));
    throw err;
  }

  await db
    .update(gardnersDropshipOrders)
    .set({ status: 'submitted', remoteOrdPath: remotePath, submittedAt: new Date() })
    .where(eq(gardnersDropshipOrders.id, orderId));

  logger.info('Gardners dropship order submitted', {
    orderId,
    fileStem: order.fileStem,
    testing: order.testing,
    lineCount: lines.length,
  });
}

export type PollAckOutcome =
  | { status: 'not_ready' }
  | { status: 'header_rejected'; message: string | null }
  | { status: 'acknowledged'; fulfilled: number; backordered: number; rejected: number };

/**
 * Checks HOMEACK for `${fileStem}.ACK` (gated on the `${fileStem}.ACK.DONE`
 * sentinel Gardners writes once the ACK file is safe to read) and, if
 * present, parses it and reconciles the result onto the order + line rows.
 * Deletes both remote files once successfully read, per Gardners' "it's your
 * responsibility to remove ack/.done files" convention. Safe to call
 * repeatedly — returns `{ status: 'not_ready' }` until the file shows up.
 */
async function pollAck(orderId: number): Promise<PollAckOutcome> {
  const { order, lines } = await getOrder(orderId);
  if (order.status !== 'submitted') {
    throw new Error(`Order ${orderId} is not awaiting an ack (status=${order.status})`);
  }

  const ackPath = `${HOME_DELIVERY_DIRS.ack}/${order.fileStem}.ACK`;
  const donePath = `${ackPath}.DONE`;

  const raw = await withDropshipSftp(async (client) => {
    const ready = await client.exists(donePath);
    if (!ready) return null;

    const buffer = (await client.get(ackPath)) as Buffer;
    await client.delete(ackPath).catch(() => undefined);
    await client.delete(donePath).catch(() => undefined);
    return buffer.toString('ascii');
  });

  if (raw === null) return { status: 'not_ready' };

  const parsed = parseAckFile(raw);

  if (parsed.headerRejected) {
    await db
      .update(gardnersDropshipOrders)
      .set({
        status: 'rejected',
        rawAck: raw,
        remoteAckPath: ackPath,
        headerErrorMessage: parsed.headerErrorMessage,
        acknowledgedAt: new Date(),
      })
      .where(eq(gardnersDropshipOrders.id, orderId));
    return { status: 'header_rejected', message: parsed.headerErrorMessage };
  }

  const byUniqueRef = new Map(parsed.lines.map((l) => [Number(l.uniqueReference), l]));

  let fulfilled = 0;
  let backordered = 0;
  let rejected = 0;

  for (const line of lines) {
    const ack = byUniqueRef.get(line.id);
    if (!ack) continue; // ack didn't echo this line back — leave as 'pending'

    const errorMessage = ack.fieldErrors.length
      ? ack.fieldErrors.map((e) => `${e.field}=${e.value}: ${e.message}`).join('; ')
      : null;

    let status: GardnersDropshipOrderLine['status'];
    if (ack.rejected) {
      status = 'rejected';
      rejected++;
    } else if (ack.quantitySupplied === null || ack.quantitySupplied === 0) {
      status = 'backordered';
      backordered++;
    } else if (ack.quantitySupplied < ack.quantity) {
      status = 'partial';
      fulfilled++;
    } else {
      status = 'fulfilled';
      fulfilled++;
    }

    await db
      .update(gardnersDropshipOrderLines)
      .set({
        status,
        gardnersRef: ack.gardnersRef,
        quantitySupplied: ack.quantitySupplied,
        reportCode: ack.report,
        reportDate: toIsoDate(ack.reportDate),
        lineErrorMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(gardnersDropshipOrderLines.id, line.id));
  }

  await db
    .update(gardnersDropshipOrders)
    .set({
      status: 'acknowledged',
      rawAck: raw,
      remoteAckPath: ackPath,
      acknowledgedAt: new Date(),
    })
    .where(eq(gardnersDropshipOrders.id, orderId));

  logger.info('Gardners dropship order acknowledged', { orderId, fulfilled, backordered, rejected });

  return { status: 'acknowledged', fulfilled, backordered, rejected };
}

export interface DispatchedLineResult {
  orderLineId: number;
  dropshipOrderId: number;
  dispatchNo: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  dispatchedOn: string | null;
}

export interface PollDispatchesOutcome {
  /** `.HDD` files collected and processed this run. */
  filesProcessed: number;
  /** DETAIL records read across those files. */
  recordsRead: number;
  /** Records that were new to us — the rest were already recorded. */
  recordsApplied: number;
  /** Records naming a unique reference we have no order line for. */
  unmatched: number;
  dispatched: DispatchedLineResult[];
}

/**
 * How many `.HDD` files one poll will collect.
 *
 * Unlike the ack poll, this is not scoped to a single order: HDD files are
 * account-wide, and if polling has been down for a while the directory can
 * hold a backlog. A cap keeps one run bounded — the rest are collected on the
 * next pass a few minutes later, which is soon enough for a dispatch
 * notification and much better than one run holding an SFTP session open for
 * an unbounded stretch.
 */
const MAX_DISPATCH_FILES_PER_POLL = 25;

/**
 * Collects dispatch files from HOMEDISP and records what shipped.
 *
 * **Structurally different from `pollAck`, and the difference matters.** An ack
 * is per-order: we know its filename because we chose it. A dispatch file is
 * per-*account* — Gardners numbers them itself, "usually from 00000001.HDD and
 * upwards, although this may change without prior warning" — and one file
 * carries dispatches for many different orders. So this lists the directory
 * rather than fetching a known name, and fans each DETAIL record out to
 * whichever order line it names.
 *
 * The link is the UNIQUE REFERENCE we sent in the .ORD, which is the order
 * line's own id. Note that the ISBN in the dispatch record is deliberately
 * *not* used to match: the spec allows a title to be slipped to a different
 * edition, so the ISBN can legitimately differ from the one ordered.
 *
 * Every file is gated on Gardners' `.DONE` sentinel, exactly as the acks are,
 * and deleted once read — per the spec's "it is your responsibility to remove
 * these files", with the added warning that a directory left to grow makes
 * every future listing slower.
 *
 * Safe to call repeatedly. Re-reading a file that was already processed inserts
 * nothing, because `uq_gardners_dropship_dispatch_line` makes a repeat a no-op
 * rather than a second shipment.
 */
async function pollDispatches(): Promise<PollDispatchesOutcome> {
  const outcome: PollDispatchesOutcome = {
    filesProcessed: 0,
    recordsRead: 0,
    recordsApplied: 0,
    unmatched: 0,
    dispatched: [],
  };

  const files = await withDropshipSftp(async (client) => {
    const entries = await client.list(HOME_DELIVERY_DIRS.dispatch);
    const names = new Set(entries.map((entry) => entry.name));

    // Only files whose .DONE sentinel is present — anything else may still be
    // being written on Gardners' side.
    const ready = entries
      .filter((entry) => entry.type === '-' && /\.HDD$/i.test(entry.name))
      .filter((entry) => names.has(`${entry.name}.DONE`))
      // Sort by the numeric prefix Gardners embeds in the name, with the
      // filename as a tie-break. The spec warns numbering "may change without
      // prior warning" — a jump from eight digits to nine sorts wrong
      // lexically, and a 25-file cap would then starve the older files
      // indefinitely.
      .sort((a, b) => {
        const na = Number((a.name.match(/^\d+/) ?? ['0'])[0]);
        const nb = Number((b.name.match(/^\d+/) ?? ['0'])[0]);
        return na - nb || a.name.localeCompare(b.name);
      })
      .map((entry) => entry.name)
      .slice(0, MAX_DISPATCH_FILES_PER_POLL);

    // Read only. Deletion happens after DB writes complete for each file —
    // deleting first would lose the dispatch permanently if any DB write
    // failed, and Gardners' .DONE sentinel is dropped alongside, so a lost
    // file cannot be recovered by a later poll.
    const collected: { name: string; raw: string }[] = [];
    for (const name of ready) {
      const remotePath = `${HOME_DELIVERY_DIRS.dispatch}/${name}`;
      const buffer = (await client.get(remotePath)) as Buffer;
      collected.push({ name, raw: buffer.toString('ascii') });
    }
    return collected;
  });

  const filesFullyProcessed: string[] = [];

  for (const file of files) {
    outcome.filesProcessed += 1;
    const parsed = parseHddFile(file.raw);
    outcome.recordsRead += parsed.lines.length;

    if (parsed.lines.length === 0) {
      // Nothing to write for an empty file, but Gardners will keep re-serving
      // it on every poll unless we clean up.
      filesFullyProcessed.push(file.name);
      continue;
    }

    // One lookup per file rather than per record: a dispatch file can hold
    // hundreds of DETAIL lines, and they are all keyed on a column we can
    // fetch in a single IN.
    const lineIds = [...new Set(parsed.lines.map((l) => Number(l.uniqueReference)))].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (lineIds.length === 0) {
      outcome.unmatched += parsed.lines.length;
      filesFullyProcessed.push(file.name);
      continue;
    }

    const known = await db
      .select({ id: gardnersDropshipOrderLines.id, orderId: gardnersDropshipOrderLines.orderId })
      .from(gardnersDropshipOrderLines)
      .where(inArray(gardnersDropshipOrderLines.id, lineIds));
    const orderIdByLine = new Map(known.map((row) => [row.id, row.orderId]));

    let fileWritesOk = true;

    for (const record of parsed.lines) {
      const lineId = Number(record.uniqueReference);
      const dropshipOrderId = orderIdByLine.get(lineId);

      if (dropshipOrderId === undefined) {
        // A dispatch for a line we have no record of. Logged, not thrown: the
        // spec says Gardners keeps files for 30 days, so an old file collected
        // after a database restore is a plausible cause — and one stray record
        // must not cost us the rest of the file.
        outcome.unmatched += 1;
        logger.warn('Dispatch record for an unknown order line', {
          file: file.name,
          uniqueReference: record.uniqueReference,
          dispatchNo: record.dispatchNo,
        });
        continue;
      }

      try {
        const applied = await recordDispatch(lineId, record, file.name);
        if (!applied) continue;

        outcome.recordsApplied += 1;
        outcome.dispatched.push({
          orderLineId: lineId,
          dropshipOrderId,
          dispatchNo: record.dispatchNo,
          carrier: record.carrier,
          trackingNumber: record.trackingNumber,
          trackingUrl: record.trackingUrl,
          dispatchedOn: record.dispatchedOn,
        });
      } catch (err) {
        // Any DB failure on a single record blocks deletion of the whole
        // file. The unique index makes re-processing on the next poll a
        // no-op for records that did land, so a retry is cheap.
        fileWritesOk = false;
        logger.error('Failed to record dispatch', {
          file: file.name,
          uniqueReference: record.uniqueReference,
          error: (err as Error).message,
        });
      }
    }

    if (fileWritesOk) filesFullyProcessed.push(file.name);
  }

  if (filesFullyProcessed.length > 0) {
    // Clean-up pass, per the spec's "it is your responsibility to remove
    // these files". A delete that itself fails is not worth aborting for —
    // the next poll will find the file still present, re-read it, and the
    // unique index will keep the inserts a no-op.
    await withDropshipSftp(async (client) => {
      for (const name of filesFullyProcessed) {
        const remotePath = `${HOME_DELIVERY_DIRS.dispatch}/${name}`;
        await client.delete(remotePath).catch(() => undefined);
        await client.delete(`${remotePath}.DONE`).catch(() => undefined);
      }
    });
  }

  if (outcome.filesProcessed > 0) {
    logger.info('Gardners dispatch files processed', {
      files: outcome.filesProcessed,
      read: outcome.recordsRead,
      applied: outcome.recordsApplied,
      unmatched: outcome.unmatched,
    });
  }

  return outcome;
}

/**
 * Writes one dispatch row and advances the line's status.
 *
 * Returns false when the row already existed, which is the ordinary outcome of
 * re-reading a file. `onConflictDoNothing` rather than a select-then-insert:
 * two workers can poll at once (the cron runs in every process), and only the
 * unique index can actually arbitrate that.
 */
async function recordDispatch(
  orderLineId: number,
  record: HddDispatchLine,
  sourceFile: string,
): Promise<boolean> {
  // The insert and the line-status advance must land together. Without the
  // transaction, a connection drop between them leaves the dispatch row in
  // place with the line still marked `pending`; the unique index then makes
  // every subsequent poll a no-op, so nothing ever fixes it.
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(gardnersDropshipDispatches)
      .values({
        orderLineId,
        dispatchNo: record.dispatchNo,
        isbn13: record.isbn13,
        quantity: record.quantity,
        dispatchedOn: record.dispatchedOn,
        pricePence: record.pricePence,
        deliveryPence: record.deliveryPence,
        discountBasisPoints: record.discountBasisPoints,
        carrier: record.carrier,
        trackingNumber: record.trackingNumber,
        trackingUrl: record.trackingUrl,
        rawDetail: record.descriptionLines.join('\n') || null,
        sourceFile,
      })
      .onConflictDoNothing({
        target: [gardnersDropshipDispatches.dispatchNo, gardnersDropshipDispatches.orderLineId],
      })
      .returning({ id: gardnersDropshipDispatches.id });

    if (inserted.length === 0) return false;

    // A dispatched line is fulfilled by definition — the books physically left
    // the warehouse. Only ever an upgrade: a line already marked `rejected`
    // keeps that, because a rejection followed by a dispatch is a contradiction
    // an operator should see rather than one this should quietly resolve.
    await tx
      .update(gardnersDropshipOrderLines)
      .set({ status: 'fulfilled', updatedAt: new Date() })
      .where(
        and(
          eq(gardnersDropshipOrderLines.id, orderLineId),
          inArray(gardnersDropshipOrderLines.status, ['pending', 'partial', 'backordered']),
        ),
      );

    return true;
  });
}

/** Creates the order rows, then immediately submits it. Convenience wrapper for the common case. */
async function createAndSubmit(input: CreateOrderInput): Promise<OrderWithLines> {
  const created = await createOrder(input);
  await submitOrder(created.order.id);
  return getOrder(created.order.id);
}

export const gardnersDropshipOrderService = {
  createOrder,
  submitOrder,
  pollAck,
  pollDispatches,
  createAndSubmit,
  getOrder,
};
