import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlus } from '../middleware/require-plus.middleware';
import { communityController } from '../controllers/community.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

// Reading the community is free; taking part in it is Plus. Note the asymmetry
// on every pair below: creating and editing are gated, deleting and unliking
// are not. A member who lapses keeps everything they made and can always take
// it back down — they just can't add more (the "retain, read-only" downgrade).

// Search
router.get('/search', wrap(communityController.search));

// Friend book detail
router.get('/users/:friendId/books/:bookId', wrap(communityController.getFriendBookDetail));

// Posts
router.get('/posts', wrap(communityController.listPosts));
router.post('/posts', requirePlus, wrap(communityController.createPost));
router.get('/posts/mine', wrap(communityController.listOwnPosts));
router.get('/books/:bookId/posts', wrap(communityController.listPostsForBook));
router.get('/posts/:postId', wrap(communityController.getPost));
router.patch('/posts/:postId', requirePlus, wrap(communityController.updatePost));
router.delete('/posts/:postId', wrap(communityController.deletePost));

// Post likes
router.post('/posts/:postId/like', requirePlus, wrap(communityController.likePost));
router.delete('/posts/:postId/like', wrap(communityController.unlikePost));

// Comments
router.get('/posts/:postId/comments', wrap(communityController.listComments));
router.post('/posts/:postId/comments', requirePlus, wrap(communityController.addComment));
router.patch('/comments/:commentId', requirePlus, wrap(communityController.updateComment));
router.delete('/comments/:commentId', wrap(communityController.deleteComment));

// Comment likes
router.post('/comments/:commentId/like', requirePlus, wrap(communityController.likeComment));
router.delete('/comments/:commentId/like', wrap(communityController.unlikeComment));

export default router;
