/**
 * Orchestrates the Gardners I12 Home Delivery (dropship) order → ack cycle:
 * persist an order + lines, build and upload the .ORD file to HOMEORD, then
 * poll HOMEACK for the matching .ACK (gated on Gardners' `.DONE` sentinel,
 * same convention onix_ingester's feed fetcher uses) and reconcile it back
 * onto the DB rows.
 *
 * Deliberately out of scope for this first cut: dispatch (.HDD) polling,
 * backorder (BACKORD.TXT) reconciliation, cancellation (.CRF/.CRA), and ASN
 * invoice ingestion. Those are separate, later pieces of the same I12 cycle
 * (see the spec) — this covers order submission through acknowledgement,
 * which is the part needed to prove the purchase flow end to end.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  gardnersDropshipOrders,
  gardnersDropshipOrderLines,
  type GardnersDropshipOrder,
  type GardnersDropshipOrderLine,
} from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { withDropshipSftp, HOME_DELIVERY_DIRS } from './connection.service';
import { buildOrderFile, type RecipientAddress } from './order-builder';
import { parseAckFile } from './ack-parser';

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
  createAndSubmit,
  getOrder,
};
