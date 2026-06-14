import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { communityController } from '../controllers/community.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

// Search
router.get('/search', wrap(communityController.search));

// Friend book detail
router.get('/users/:friendId/books/:bookId', wrap(communityController.getFriendBookDetail));

// Posts
router.get('/posts', wrap(communityController.listPosts));
router.post('/posts', wrap(communityController.createPost));
router.get('/books/:bookId/posts', wrap(communityController.listPostsForBook));
router.get('/posts/:postId', wrap(communityController.getPost));
router.patch('/posts/:postId', wrap(communityController.updatePost));
router.delete('/posts/:postId', wrap(communityController.deletePost));

// Post likes
router.post('/posts/:postId/like', wrap(communityController.likePost));
router.delete('/posts/:postId/like', wrap(communityController.unlikePost));

// Comments
router.get('/posts/:postId/comments', wrap(communityController.listComments));
router.post('/posts/:postId/comments', wrap(communityController.addComment));
router.patch('/comments/:commentId', wrap(communityController.updateComment));
router.delete('/comments/:commentId', wrap(communityController.deleteComment));

// Comment likes
router.post('/comments/:commentId/like', wrap(communityController.likeComment));
router.delete('/comments/:commentId/like', wrap(communityController.unlikeComment));

export default router;
