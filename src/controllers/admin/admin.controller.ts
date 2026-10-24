import { Request, Response } from 'express';
import { z } from 'zod';
import type { AdminRequest } from '../../middleware/admin-auth.middleware';
import { adminAuthService } from '../../services/admin/auth.service';
import { adminDashboardService } from '../../services/admin/dashboard.service';
import { adminOrdersService } from '../../services/admin/orders.service';
import { adminCustomersService } from '../../services/admin/customers.service';
import { adminReportsService } from '../../services/admin/reports.service';
import { adminModerationService } from '../../services/admin/moderation.service';
import { adminSettingsService, BANNER_SLOTS } from '../../services/admin/settings.service';
import { adminNotificationsService } from '../../services/admin/notifications.service';
import { adminShippingMarginService } from '../../services/admin/shipping-margin.service';
import { adminReferralsService } from '../../services/admin/referrals.service';
import { adminRestockRequestsService } from '../../services/admin/restock-requests.service';
import { csvDocument } from '../../lib/csv';
import { formatMinor } from '../../lib/money';
import { logger } from '../../lib/logger';

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  // Same floor the seeding script enforces. These accounts can suspend a
  // customer and export the customer list.
  newPassword: z.string().min(12).max(200),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ordersQuerySchema = pageSchema.extend({
  tab: z.enum(['all', 'processing', 'shipped', 'delivered', 'needs_attention', 'unpaid']).default('all'),
  q: z.string().trim().min(1).max(200).optional(),
  // The design expands a row in place, so the client can pull the lines for the
  // whole page up front and expand without a round trip.
  withItems: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

/**
 * A window and a cap. 90 days matches how often Gardners reissue rates, so the
 * default view is roughly "since the last price change".
 */
const shippingMarginQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const customersQuerySchema = pageSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});

const travellersQuerySchema = pageSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['points', 'signups', 'recent']).default('points'),
});

/** The `:id` of a report route, or undefined after answering 400. */
function reportIdParam(req: Request, res: Response): number | undefined {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid report id' });
    return undefined;
  }
  return id;
}

const reportsQuerySchema = pageSchema.extend({
  status: z.enum(['pending', 'resolved', 'dismissed']).optional(),
  // Narrows the queue to one kind of target. Also the escape hatch for a console
  // written before groups were reportable: `?targetType=user` returns exactly
  // the rows, and exactly the shape, it saw before — every row with a
  // `reportedUser` attached.
  targetType: z.enum(['user', 'group']).optional(),
  // The screen's tabs: User Reports, Group Reports, Posts & Reviews.
  category: z.enum(['user', 'group', 'content']).optional(),
});

const restockQuerySchema = pageSchema.extend({
  // The design's tabs: All (no status), Pending, Fulfilled.
  status: z.enum(['all', 'pending', 'fulfilled']).default('all')
    .transform((v) => (v === 'all' ? undefined : v)),
  q: z.string().trim().min(1).max(200).optional(),
});

function positiveId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const blacklistSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const bannersSchema = z.object({
  banners: z
    .array(
      z.object({
        slot: z.enum(BANNER_SLOTS),
        enabled: z.boolean(),
        // Empty text with enabled=true would render an empty strip on every
        // page, so it is rejected rather than silently hidden.
        text: z.string().trim().max(200),
      }),
    )
    .min(1)
    .max(BANNER_SLOTS.length)
    .refine((list) => list.every((b) => !b.enabled || b.text.length > 0), {
      message: 'An enabled banner needs text',
    })
    .refine((list) => new Set(list.map((b) => b.slot)).size === list.length, {
      message: 'Each slot may appear only once',
    }),
});

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.flatten().fieldErrors });
}

const EXPORT_ROW_CAP = 5000;

/**
 * Sets the download headers, and says so loudly when the export was truncated.
 *
 * The cap protects the server, but a silently truncated export is worse than a
 * refused one: an operator who asks for 12,000 customers, receives 5,000 and is
 * told nothing will believe they are holding the whole list. The header is there
 * for API callers, and the **filename** carries it too, because that is the only
 * part an operator clicking a download button ever actually sees.
 */
function sendCsv(res: Response, name: string, rows: number, total: number, csv: string): void {
  const truncated = total > rows;
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = truncated
    ? `kinkane-${name}-${stamp}-FIRST-${rows}-OF-${total}.csv`
    : `kinkane-${name}-${stamp}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Total-Rows', String(total));
  res.setHeader('X-Exported-Rows', String(rows));
  if (truncated) res.setHeader('X-Truncated', 'true');
  res.status(200).send(csv);
}

export const adminController = {
  /** POST /admin/auth/login */
  async login(req: Request, res: Response): Promise<void> {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const session = await adminAuthService.login(parsed.data.email, parsed.data.password);
    res.status(200).json(session);
  },

  /** GET /admin/auth/me */
  async me(req: Request, res: Response): Promise<void> {
    const { id, name, email, lastLoginAt } = (req as AdminRequest).admin;
    res.status(200).json({ admin: { id, name, email, lastLoginAt } });
  },

  /** POST /admin/console/auth/change-password */
  async changePassword(req: Request, res: Response): Promise<void> {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const admin = (req as AdminRequest).admin;
    const session = await adminAuthService.changePassword(
      admin.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );

    // The change signs out every earlier session, the caller's included, so
    // the console must swap in this one or its next request gets a 401.
    res.status(200).json({ changed: true, ...session });
  },

  /** POST /admin/console/auth/forgot-password */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    // Answer first, then do the work. For a real admin the work includes a
    // write that a non-admin address skips, so awaiting it would let response
    // time reveal which addresses are staff. Failures are logged, not returned,
    // for the same reason.
    res.status(200).json({ sent: true });
    adminAuthService.requestPasswordReset(parsed.data.email).catch((err) => {
      logger.error('Admin password reset request failed', { error: (err as Error).message });
    });
  },

  /** POST /admin/console/auth/reset-password */
  async resetPassword(req: Request, res: Response): Promise<void> {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    await adminAuthService.resetPassword(parsed.data.token, parsed.data.newPassword);
    res.status(200).json({ reset: true });
  },

  /** GET /admin/dashboard */
  async dashboard(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminDashboardService.overview());
  },

  /** GET /admin/badges */
  async badges(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminDashboardService.badges());
  },

  /** GET /admin/orders */
  async orders(req: Request, res: Response): Promise<void> {
    const parsed = ordersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    const result = await adminOrdersService.list(parsed.data);

    if (parsed.data.withItems) {
      const items = await adminOrdersService.itemsFor(result.orders.map((o) => o.id));
      res.status(200).json({
        ...result,
        orders: result.orders.map((o) => ({ ...o, items: items.get(o.id) ?? [] })),
      });
      return;
    }

    res.status(200).json(result);
  },

  /**
   * GET /admin/shipping-margin
   *
   * What we charged for postage against what it cost us. The one screen that
   * would have caught the original problem — postage sold below cost on every
   * destination outside Europe — without anyone cross-referencing a
   * spreadsheet.
   */
  async shippingMargin(req: Request, res: Response): Promise<void> {
    const parsed = shippingMarginQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    res.status(200).json(await adminShippingMarginService.report(parsed.data));
  },

  /** GET /admin/console/referrals/analytics — totals, weekly and cumulative. */
  async referralAnalytics(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminReferralsService.analytics());
  },

  /** GET /admin/console/referrals/travellers — every Traveller, paginated. */
  async referralTravellers(req: Request, res: Response): Promise<void> {
    const parsed = travellersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(200).json(await adminReferralsService.travellers(parsed.data));
  },

  /** GET /admin/orders/export */
  async ordersExport(req: Request, res: Response): Promise<void> {
    const parsed = ordersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    // Exports the current filter rather than everything, so what downloads is
    // what the operator is looking at. Capped: an unbounded export of a growing
    // table is a way to take the server down from a button.
    const result = await adminOrdersService.list({ ...parsed.data, limit: EXPORT_ROW_CAP, offset: 0 });

    const csv = csvDocument(
      ['Reference', 'Placed', 'Paid', 'Customer', 'Email', 'Phone', 'Status', 'Items', 'Currency', 'Subtotal', 'Discount', 'Shipping', 'Tax', 'Total', 'Ship to', 'Country'],
      result.orders.map((o) => [
        o.reference,
        o.placedAt?.toISOString() ?? '',
        o.paidAt?.toISOString() ?? '',
        o.customerName ?? '',
        o.contactEmail,
        o.contactPhone ?? '',
        o.status,
        o.itemCount,
        o.currency,
        formatMinor(o.subtotalMinor, o.currency),
        formatMinor(o.discountMinor, o.currency),
        formatMinor(o.shippingMinor, o.currency),
        formatMinor(o.taxMinor, o.currency),
        formatMinor(o.totalMinor, o.currency),
        [o.shippingLine1, o.shippingLine2, o.shippingCity, o.shippingPostcode].filter(Boolean).join(', '),
        o.shippingCountryCode,
      ]),
    );

    sendCsv(res, 'orders', result.orders.length, result.total, csv);
  },

  /** GET /admin/customers */
  async customers(req: Request, res: Response): Promise<void> {
    const parsed = customersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(200).json(await adminCustomersService.list(parsed.data));
  },

  /** GET /admin/customers/export */
  async customersExport(req: Request, res: Response): Promise<void> {
    const parsed = customersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    const result = await adminCustomersService.list({ ...parsed.data, limit: EXPORT_ROW_CAP, offset: 0 });

    const csv = csvDocument(
      ['Customer', 'Email', 'Country', 'Orders', 'Total spent (minor units)', 'Last order', 'Status', 'Joined'],
      result.customers.map((c) => [
        c.name,
        c.email,
        c.countryCode ?? '',
        c.orders,
        c.totalSpentMinor,
        c.lastOrderAt ? new Date(c.lastOrderAt).toISOString() : '',
        c.blacklisted ? 'Blacklisted' : c.active ? 'Active' : 'Inactive',
        c.joinedAt.toISOString(),
      ]),
    );

    sendCsv(res, 'customers', result.customers.length, result.total, csv);
  },

  /** POST /admin/customers/:id/blacklist */
  async blacklistCustomer(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid customer id' });
      return;
    }
    const parsed = blacklistSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);

    const admin = (req as AdminRequest).admin;
    res.status(200).json(await adminCustomersService.blacklist(id, admin.id, parsed.data.reason ?? null));
  },

  /** DELETE /admin/customers/:id/blacklist */
  async unblacklistCustomer(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid customer id' });
      return;
    }
    res.status(200).json(await adminCustomersService.unblacklist(id));
  },

  /** GET /admin/reports */
  async reports(req: Request, res: Response): Promise<void> {
    const parsed = reportsQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(200).json(await adminReportsService.list(parsed.data));
  },

  /** POST /admin/reports/:id/dismiss */
  async dismissReport(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid report id' });
      return;
    }
    const admin = (req as AdminRequest).admin;
    res.status(200).json(await adminReportsService.dismiss(id, admin.id));
  },

  /** POST /admin/reports/:id/blacklist */
  async blacklistFromReport(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid report id' });
      return;
    }
    const admin = (req as AdminRequest).admin;
    res.status(200).json(await adminReportsService.blacklistAndResolve(id, admin.id));
  },

  /** POST /admin/reports/:id/hide — hides the post, review or comment the report cites. */
  async hideFromReport(req: Request, res: Response): Promise<void> {
    const id = reportIdParam(req, res);
    if (id === undefined) return;
    res.status(200).json(await adminModerationService.hide(id, (req as AdminRequest).admin.id));
  },

  /** POST /admin/reports/:id/unhide */
  async unhideFromReport(req: Request, res: Response): Promise<void> {
    const id = reportIdParam(req, res);
    if (id === undefined) return;
    res.status(200).json(await adminModerationService.unhide(id));
  },

  /** POST /admin/reports/:id/blacklist-group */
  async blacklistGroupFromReport(req: Request, res: Response): Promise<void> {
    const id = reportIdParam(req, res);
    if (id === undefined) return;
    res.status(200).json(await adminModerationService.blacklistGroup(id, (req as AdminRequest).admin.id));
  },

  /** POST /admin/reports/:id/unblacklist-group */
  async unblacklistGroupFromReport(req: Request, res: Response): Promise<void> {
    const id = reportIdParam(req, res);
    if (id === undefined) return;
    res.status(200).json(await adminModerationService.unblacklistGroup(id));
  },

  /** GET /admin/console/restock-requests */
  async restockRequests(req: Request, res: Response): Promise<void> {
    const parsed = restockQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(200).json(await adminRestockRequestsService.list(parsed.data));
  },

  /** GET /admin/console/restock-requests/export */
  async restockRequestsExport(req: Request, res: Response): Promise<void> {
    const parsed = restockQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    // The current tab and search, as with every other export here.
    const result = await adminRestockRequestsService.exportRows(parsed.data, EXPORT_ROW_CAP);

    const csv = csvDocument(
      ['Reference', 'Requested', 'Title', 'Author', 'Format', 'ISBN', 'Customer', 'Email', 'Signed in', 'Status', 'Fulfilled'],
      result.rows.map((r) => [
        r.reference ?? '',
        r.requestedAt.toISOString(),
        r.title,
        r.author ?? '',
        r.format ?? '',
        r.isbn13,
        r.name ?? 'Anonymous',
        r.email ?? '',
        r.userId !== null ? 'Yes' : 'No',
        r.status === 'fulfilled' ? 'Fulfilled' : 'Pending',
        r.fulfilledAt?.toISOString() ?? '',
      ]),
    );

    sendCsv(res, 'restock-requests', result.rows.length, result.total, csv);
  },

  /** POST /admin/console/restock-requests/:id/fulfil */
  async fulfilRestockRequest(req: Request, res: Response): Promise<void> {
    const id = positiveId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid restock request id' });
      return;
    }
    const admin = (req as AdminRequest).admin;
    res.status(200).json(await adminRestockRequestsService.fulfil(id, admin.id));
  },

  /** POST /admin/console/restock-requests/:id/reopen */
  async reopenRestockRequest(req: Request, res: Response): Promise<void> {
    const id = positiveId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid restock request id' });
      return;
    }
    res.status(200).json(await adminRestockRequestsService.reopen(id));
  },

  /** POST /admin/console/restock-requests/books/:bookId/fulfil */
  async fulfilRestockRequestsForBook(req: Request, res: Response): Promise<void> {
    const bookId = positiveId(req.params.bookId);
    if (bookId === null) {
      res.status(400).json({ error: 'Invalid book id' });
      return;
    }
    const admin = (req as AdminRequest).admin;
    res.status(200).json(await adminRestockRequestsService.fulfilAllForBook(bookId, admin.id));
  },

  /** GET /admin/settings/banners */
  async banners(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ banners: await adminSettingsService.list() });
  },

  /** PUT /admin/settings/banners */
  async updateBanners(req: Request, res: Response): Promise<void> {
    const parsed = bannersSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const admin = (req as AdminRequest).admin;
    res.status(200).json({ banners: await adminSettingsService.update(parsed.data.banners, admin.id) });
  },

  /** GET /admin/notifications */
  async notifications(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminNotificationsService.list());
  },

  /** POST /admin/notifications/read-all */
  async markNotificationsRead(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminNotificationsService.markAllRead());
  },

  /** DELETE /admin/notifications */
  async clearNotifications(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await adminNotificationsService.clear());
  },
};
