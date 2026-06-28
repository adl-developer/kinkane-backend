import { Response } from 'express';
import { z } from 'zod';
import { communityService } from '../services/community.service';
import { communitySearchService } from '../services/community-search.service';
import { parseId } from '../lib/route-helpers';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const createPostSchema = z.object({
  bookId: z.number().int().positive(),
  rating: z.number().int().min(1).max(5),
  status: z.enum(['reading', 'read']),
  body: z.string().max(5000).optional(),
  isPublic: z.boolean(),
});

const updatePostSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  status: z.enum(['reading', 'read']).optional(),
  body: z.string().max(5000).nullable().optional(),
  isPublic: z.boolean().optional(),
}).refine(
  (d) => d.rating !== undefined || d.status !== undefined || d.body !== undefined || d.isPublic !== undefined,
  { message: 'At least one field must be provided' },
);

const addCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});

const updateCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const listPostsSchema = paginationSchema.extend({
  sort: z.enum(['date_asc', 'date_desc']).default('date_desc'),
});

const searchSchema = paginationSchema.extend({
  q: z.string().min(1).max(200).trim(),
  filter: z.enum(['all', 'users', 'posts']).default('all'),
});

export const communityController = {
  // ── Posts ───────────────────────────────────────────────────────────────────

  async createPost(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const result = await communityService.createPost(req.user.id, parsed.data);
      res.status(201).json(result);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async getPost(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const postId = parseId(req.params.postId, 'post ID');
      const post = await communityService.getPost(postId, req.user.id);
      res.status(200).json(post);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async updatePost(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = updatePostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const postId = parseId(req.params.postId, 'post ID');
      await communityService.updatePost(postId, req.user.id, parsed.data);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async deletePost(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const postId = parseId(req.params.postId, 'post ID');
      await communityService.deletePost(postId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listPosts(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listPostsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const result = await communityService.listPosts(
        req.user.id,
        parsed.data.sort,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.status(200).json({ ...result, sort: parsed.data.sort, limit: parsed.data.limit, offset: parsed.data.offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listOwnPosts(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listPostsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const result = await communityService.listOwnPosts(
        req.user.id,
        parsed.data.sort,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.status(200).json({ ...result, sort: parsed.data.sort, limit: parsed.data.limit, offset: parsed.data.offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listPostsForBook(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listPostsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const bookId = parseId(req.params.bookId, 'book ID');
      const result = await communityService.listPostsForBook(
        bookId,
        req.user.id,
        parsed.data.sort,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.status(200).json({ ...result, sort: parsed.data.sort, limit: parsed.data.limit, offset: parsed.data.offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  // ── Post likes ──────────────────────────────────────────────────────────────

  async likePost(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const postId = parseId(req.params.postId, 'post ID');
      await communityService.likePost(postId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async unlikePost(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const postId = parseId(req.params.postId, 'post ID');
      await communityService.unlikePost(postId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  // ── Comments ────────────────────────────────────────────────────────────────

  async listComments(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const postId = parseId(req.params.postId, 'post ID');
      const result = await communityService.listComments(
        postId,
        req.user.id,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.status(200).json({ ...result, limit: parsed.data.limit, offset: parsed.data.offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async addComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = addCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const postId = parseId(req.params.postId, 'post ID');
      const result = await communityService.addComment(postId, req.user.id, parsed.data.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async updateComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = updateCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const commentId = parseId(req.params.commentId, 'comment ID');
      await communityService.updateComment(commentId, req.user.id, parsed.data.body);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async deleteComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const commentId = parseId(req.params.commentId, 'comment ID');
      await communityService.deleteComment(commentId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  // ── Comment likes ───────────────────────────────────────────────────────────

  async likeComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const commentId = parseId(req.params.commentId, 'comment ID');
      await communityService.likeComment(commentId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async unlikeComment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const commentId = parseId(req.params.commentId, 'comment ID');
      await communityService.unlikeComment(commentId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  // ── Friend book detail ──────────────────────────────────────────────────────

  async getFriendBookDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const friendId = parseId(req.params.friendId, 'friend ID');
      const bookId = parseId(req.params.bookId, 'book ID');
      const result = await communityService.getFriendBookDetail(friendId, bookId, req.user.id);
      res.status(200).json(result);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const result = await communitySearchService.search(
        parsed.data.q,
        parsed.data.filter,
        req.user.id,
        parsed.data.limit,
        parsed.data.offset,
      );
      res.status(200).json({
        ...result,
        filter: parsed.data.filter,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
