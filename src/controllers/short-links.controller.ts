import { Request, Response } from 'express';
import { z } from 'zod';
import { shortLinksService } from '../services/short-links.service';

const CODE_RE = /^[A-Za-z0-9]{4,16}$/;

const blockSchema = z.object({
  blocked: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/** A plain page for a link that cannot be followed. Nothing user-supplied is put in it. */
function linkPage(res: Response, status: number, heading: string, message: string): void {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="robots" content="noindex"><title>${heading} · Kinkané</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#222;text-align:center}</style>` +
        `</head><body><h1>${heading}</h1><p>${message}</p></body></html>`,
    );
}

export const shortLinksController = {
  /**
   * GET /s/:code (or /l/:code) — a tap on a short link from a post, comment, review, group
   * text or shelf note. Counts it and forwards to the address.
   *
   * Never cached, so a block takes effect on the very next tap.
   */
  async redirect(req: Request, res: Response): Promise<void> {
    res.set('Cache-Control', 'no-store');
    const code = String(req.params.code ?? '');
    const link = CODE_RE.test(code) ? await shortLinksService.follow(code) : null;

    if (!link) {
      linkPage(res, 404, 'Link not found', 'This link doesn’t exist. Check that it was copied in full.');
      return;
    }
    if (link.blocked) {
      linkPage(res, 410, 'Link removed', 'This link has been removed by Kinkané because it may be unsafe.');
      return;
    }
    res.redirect(302, link.url);
  },

  /** GET /admin/short-links/:code — what a short link points to, how often it was tapped, and whether it is blocked. */
  async adminGet(req: Request, res: Response): Promise<void> {
    const link = await shortLinksService.get(String(req.params.code));
    if (!link) {
      res.status(404).json({ error: 'Short link not found' });
      return;
    }
    res.json({ link });
  },

  /**
   * PATCH /admin/short-links/:code — switch a link off (or back on) in every
   * post, comment and note that carries it.
   *
   * Body: { blocked: boolean, reason?: string }
   */
  async adminSetBlocked(req: Request, res: Response): Promise<void> {
    const parsed = blockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }
    const link = await shortLinksService.setBlocked(String(req.params.code), parsed.data.blocked, parsed.data.reason ?? null);
    if (!link) {
      res.status(404).json({ error: 'Short link not found' });
      return;
    }
    res.json({ link });
  },
};
