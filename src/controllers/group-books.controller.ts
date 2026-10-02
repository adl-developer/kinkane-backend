import { Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { groupBooksService } from '../services/group-books.service';
import { parseId } from '../lib/route-helpers';
import {
  listGroupBooksSchema,
  addGroupBooksSchema,
  setCurrentBookSchema,
  updateGroupBookSchema,
  finishGroupBookSchema,
  createGroupCommentSchema,
  updateGroupCommentSchema,
  groupCommentPageSchema,
} from '../lib/group-book-input';

/** Parses `input` or answers 400 with the field errors; returns undefined when it answered. */
function parse<S extends ZodTypeAny>(schema: S, input: unknown, res: Response): z.infer<S> | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return undefined;
  }
  return parsed.data;
}

export const groupBooksController = {
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const query = parse(listGroupBooksSchema, req.query, res);
    if (!query) return;
    const result = await groupBooksService.list(groupId, req.user.id, query);
    res.status(200).json({ ...result, status: query.status, sort: query.sort, limit: query.limit, offset: query.offset });
  },

  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    const book = await groupBooksService.get(groupId, groupBookId, req.user.id);
    res.status(200).json({ book });
  },

  async add(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const body = parse(addGroupBooksSchema, req.body, res);
    if (!body) return;
    const result = await groupBooksService.addWantToRead(groupId, req.user.id, body.bookIds);
    // 201 even when every id was skipped — same reasoning as invitations.
    res.status(201).json(result);
  },

  async setCurrent(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const body = parse(setCurrentBookSchema, req.body, res);
    if (!body) return;
    const book = await groupBooksService.setCurrent(groupId, req.user.id, body);
    res.status(200).json({ book });
  },

  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    const body = parse(updateGroupBookSchema, req.body, res);
    if (!body) return;
    const book = await groupBooksService.update(groupId, groupBookId, req.user.id, body);
    res.status(200).json({ book });
  },

  async finish(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    const body = parse(finishGroupBookSchema, req.body, res);
    if (!body) return;
    const book = await groupBooksService.finish(groupId, groupBookId, req.user.id, body.finishedOn);
    res.status(200).json({ book });
  },

  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    await groupBooksService.remove(groupId, groupBookId, req.user.id);
    res.status(200).json({ success: true });
  },

  // ── Discussion ─────────────────────────────────────────────────────────────

  async listComments(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    const page = parse(groupCommentPageSchema, req.query, res);
    if (!page) return;
    const result = await groupBooksService.listComments(groupId, groupBookId, req.user.id, page.limit, page.offset);
    res.status(200).json({ ...result, limit: page.limit, offset: page.offset });
  },

  async listReplies(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const commentId = parseId(req.params.commentId, 'comment ID');
    const page = parse(groupCommentPageSchema, req.query, res);
    if (!page) return;
    const result = await groupBooksService.listReplies(groupId, commentId, req.user.id, page.limit, page.offset);
    res.status(200).json({ ...result, limit: page.limit, offset: page.offset });
  },

  async addComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const groupBookId = parseId(req.params.groupBookId, 'group book ID');
    const body = parse(createGroupCommentSchema, req.body, res);
    if (!body) return;
    const comment = await groupBooksService.addComment(groupId, groupBookId, req.user.id, body.body, body.parentId);
    res.status(201).json({ comment });
  },

  async updateComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const commentId = parseId(req.params.commentId, 'comment ID');
    const body = parse(updateGroupCommentSchema, req.body, res);
    if (!body) return;
    await groupBooksService.updateComment(groupId, commentId, req.user.id, body.body);
    res.status(200).json({ success: true });
  },

  async deleteComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const commentId = parseId(req.params.commentId, 'comment ID');
    await groupBooksService.deleteComment(groupId, commentId, req.user.id);
    res.status(200).json({ success: true });
  },

  async likeComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const commentId = parseId(req.params.commentId, 'comment ID');
    await groupBooksService.likeComment(groupId, commentId, req.user.id);
    res.status(200).json({ success: true });
  },

  async unlikeComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const groupId = parseId(req.params.groupId, 'group ID');
    const commentId = parseId(req.params.commentId, 'comment ID');
    await groupBooksService.unlikeComment(groupId, commentId, req.user.id);
    res.status(200).json({ success: true });
  },
};
