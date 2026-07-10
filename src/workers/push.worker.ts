import { Worker, Job } from 'bullmq';
import { bullConnection } from '../lib/email-queue';
import { PushJobMap, PushJobName } from '../lib/push-queue';
import { sendPush } from '../lib/push';
import { logger } from '../lib/logger';

// ── Job processor ─────────────────────────────────────────────────────────────
// Push messages don't need HTML templates like emails do — each case just
// builds a one-line title/body/data payload inline.

async function processPushJob(job: Job): Promise<void> {
  const name = job.name as PushJobName;

  switch (name) {
    case 'friend-request-sent': {
      const { userId, senderId, senderName } = job.data as PushJobMap['friend-request-sent'];
      await sendPush(userId, {
        title: 'New friend request',
        body: `${senderName} wants to connect with you on Kinkane.`,
        data: { type: 'friend_request', senderId: String(senderId) },
      });
      break;
    }
    case 'friend-request-accepted': {
      const { userId, accepterId, accepterName } = job.data as PushJobMap['friend-request-accepted'];
      await sendPush(userId, {
        title: 'Friend request accepted',
        body: `${accepterName} accepted your friend request.`,
        data: { type: 'friend_request_accepted', accepterId: String(accepterId) },
      });
      break;
    }
    case 'post-comment': {
      const { userId, postId, commentId, commenterName, bookTitle } = job.data as PushJobMap['post-comment'];
      await sendPush(userId, {
        title: 'New comment on your post',
        body: `${commenterName} commented on your post about ${bookTitle}.`,
        data: { type: 'post_comment', postId: String(postId), commentId: String(commentId) },
      });
      break;
    }
    case 'post-like': {
      const { userId, postId, likerName, bookTitle } = job.data as PushJobMap['post-like'];
      await sendPush(userId, {
        title: 'Someone liked your post',
        body: `${likerName} liked your post about ${bookTitle}.`,
        data: { type: 'post_like', postId: String(postId) },
      });
      break;
    }
    case 'new-recommendation': {
      const { userId, bookId, bookTitle } = job.data as PushJobMap['new-recommendation'];
      await sendPush(userId, {
        title: 'A new book pick for you',
        body: `We think you'll like ${bookTitle}.`,
        data: { type: 'new_recommendation', bookId: String(bookId) },
      });
      break;
    }
    default: {
      // Exhaustiveness check — TypeScript will catch unhandled job names at compile time
      const unhandled: never = name;
      logger.warn('Unknown push job type — skipping', { jobName: unhandled });
    }
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

export function startPushWorker(): Worker {
  const worker = new Worker('pushes', processPushJob, {
    connection: bullConnection,
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    logger.info('Push job completed', {
      jobId: job.id,
      jobName: job.name,
      userId: (job.data as { userId: number }).userId,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Push job failed', {
      jobId: job?.id,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
      error: err.message,
    });
  });

  logger.info('Push worker started', { concurrency: 5 });
  return worker;
}

export async function stopPushWorker(worker: Worker): Promise<void> {
  // Waits for the currently active job (if any) to finish before closing
  await worker.close();
  logger.info('Push worker stopped');
}
