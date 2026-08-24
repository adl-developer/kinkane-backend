import { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { contactService } from '../services/contact.service';

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  /**
   * Honeypot. Real people never see this field, so anything in it came from
   * something filling every input on the page.
   *
   * Answered with a 201 rather than a 400: telling a bot which field gave it
   * away is free tuning information, and the submission is simply dropped.
   */
  website: z.string().max(200).optional(),
});

export const contactController = {
  /** POST /api/v1/contact */
  async submit(req: Request, res: Response): Promise<void> {
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { website, ...submission } = parsed.data;
    if (website) {
      res.status(201).json({ received: true });
      return;
    }

    // Optional auth: most senders are signed out. When they are signed in the
    // account is attached, so support can see who they are talking to without
    // trusting the name in the form.
    const userId = (req as AuthenticatedRequest).user?.id ?? null;
    await contactService.submit({ ...submission, userId });

    // Deliberately no id in the response. It is our internal reference, and
    // returning it invites a "check my message" endpoint that does not exist.
    res.status(201).json({ received: true });
  },
};
