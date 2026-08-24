import { Request, Response } from 'express';
import { z } from 'zod';
import type { AdminRequest } from '../../middleware/admin-auth.middleware';
import { adminAuthService } from '../../services/admin/auth.service';
import { adminDashboardService } from '../../services/admin/dashboard.service';
import { adminOrdersService } from '../../services/admin/orders.service';
import { adminCustomersService } from '../../services/admin/customers.service';
import { adminReportsService } from '../../services/admin/reports.service';
import { adminSettingsService, BANNER_SLOTS } from '../../services/admin/settings.service';
import { adminNotificationsService } from '../../services/admin/notifications.service';
import { csvDocument } from '../../lib/csv';
import { formatMinor } from '../../lib/money';

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
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

const customersQuerySchema = pageSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
});

const reportsQuerySchema = pageSchema.extend({
  status: z.enum(['pending', 'resolved', 'dismissed']).optional(),
});

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

  /** GET /admin/orders/export */
  async ordersExport(req: Request, res: Response): Promise<void> {
    const parsed = ordersQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);

    // Exports the current filter rather than everything, so what downloads is
    // what the operator is looking at. Capped: an unbounded export of a growing
    // table is a way to take the server down from a button.
    const result = await adminOrdersService.list({ ...parsed.data, limit: 5000, offset: 0 });

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

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kinkane-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(csv);
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

    const result = await adminCustomersService.list({ ...parsed.data, limit: 5000, offset: 0 });

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

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kinkane-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.status(200).send(csv);
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
