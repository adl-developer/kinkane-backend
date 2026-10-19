import { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { restockRequestsService } from '../services/restock-requests.service';
import { resolveRequestCountry } from '../services/commerce/pricing';

/** An empty string from a cleared form field means "not given", not "invalid". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const restockSchema = z.object({
  name: optionalText(200),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(z.string().email().nullable()),
  // Honeypot, as on the contact form: answered with a 201 and dropped.
  website: z.string().max(200).optional(),
});

export const restockRequestsController = {
  /** POST /api/v1/books/:id/restock-requests */
  async submit(req: Request, res: Response): Promise<void> {
    const bookId = Number(req.params.id);
    if (!Number.isInteger(bookId) || bookId < 1) {
      res.status(400).json({ error: 'Invalid book id' });
      return;
    }

    const parsed = restockSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { website, name, email } = parsed.data;
    if (website) {
      res.status(201).json({ requested: true });
      return;
    }

    await restockRequestsService.submit({
      bookId,
      userId: (req as AuthenticatedRequest).user?.id ?? null,
      name,
      email,
      country: await resolveRequestCountry(req),
    });

    // No reference in the response, for the contact form's reason: there is no
    // customer-facing way to look a request up, so an id would invite one.
    res.status(201).json({ requested: true });
  },
};
