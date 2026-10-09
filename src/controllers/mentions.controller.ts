import { Response } from 'express';
import { z } from 'zod';
import { mentionsService } from '../services/mentions.service';
import { mentionSuggestionsService, type SuggestionContext } from '../services/mention-suggestions.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const suggestSchema = z.object({
  // Empty is allowed: the list shown straight after typing `@`.
  q: z.string().max(64).default(''),
  // `post:123`, `group:45` or `group_book:67` — where the person is typing.
  context: z
    .string()
    .regex(/^(post|group|group_book):[1-9]\d{0,9}$/, 'Expected post:<id>, group:<id> or group_book:<id>')
    .optional(),
});

function parseContext(raw: string | undefined): SuggestionContext | undefined {
  if (!raw) return undefined;
  const [type, id] = raw.split(':');
  return { type: type as SuggestionContext['type'], id: Number(id) };
}

export const mentionsController = {
  /** GET /user/mentions */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const { limit, offset } = parsed.data;
    const result = await mentionsService.list(req.user.id, limit, offset);
    res.status(200).json({ ...result, limit, offset });
  },

  /** GET /community/mention-suggestions */
  async suggest(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = suggestSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const users = await mentionSuggestionsService.suggest(req.user.id, parsed.data.q, parseContext(parsed.data.context));
    res.status(200).json({ users });
  },
};
