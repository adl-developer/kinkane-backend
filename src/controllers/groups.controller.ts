import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { groupsService } from '../services/groups.service';
import { authService } from '../services/auth.service';
import { parseId } from '../lib/route-helpers';
import { createGroupSchema, updateGroupSchema } from '../lib/group-input';

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// `q` is optional: omitted, the list is a browse. Bounds and trimming match the
// community search schema so the two behave the same way on the same input.
const listGroupsSchema = paginationSchema.extend({
  q: z.string().min(1).max(200).trim().optional(),
});

/**
 * Deleting a group asks the owner to re-prove who they are, like deleting an
 * account does. A password OR a fresh provider id token is accepted, because
 * social-login accounts have no password hash at all — `verifyOwnership`
 * handles both and is the same call the Change Plan flow makes.
 */
const deleteGroupSchema = z
  .object({
    password: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
  })
  .refine((d) => d.password !== undefined || d.idToken !== undefined, {
    message: 'A password or a fresh sign-in is required',
  });

export const groupsController = {
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const group = await groupsService.create(req.user.id, parsed.data);
    res.status(201).json({ group });
  },

  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listGroupsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const { limit, offset, q } = parsed.data;
    const result = await groupsService.list(limit, offset, q);
    // `q` is echoed back like `filter` is on community search, so a client
    // rendering results can tell a search response from a browse response.
    res.status(200).json({ ...result, ...(q !== undefined && { q }), limit, offset });
  },

  async listMine(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const { limit, offset } = parsed.data;
    const result = await groupsService.listForUser(req.user.id, limit, offset);
    res.status(200).json({ ...result, limit, offset });
  },

  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const result = await groupsService.get(groupId, req.user.id);
    res.status(200).json(result);
  },

  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const group = await groupsService.update(groupId, req.user.id, parsed.data);
    res.status(200).json({ group });
  },

  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const parsed = deleteGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    // Ownership of the *account* is verified before the group is touched, so a
    // wrong credential can never reach the delete.
    await authService.verifyOwnership(req.user.id, {
      password: parsed.data.password,
      idToken: parsed.data.idToken,
    });
    await groupsService.remove(groupId, req.user.id);
    res.status(200).json({ success: true });
  },
};
