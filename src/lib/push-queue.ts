import { Queue } from 'bullmq';
import { bullConnection } from './email-queue';

// ── Job payload types ─────────────────────────────────────────────────────────

export interface PushJobMap {
  'friend-request-sent': { userId: number; senderId: number; senderName: string };
  'friend-request-accepted': { userId: number; accepterId: number; accepterName: string };
  'post-comment': {
    userId: number;
    postId: number;
    commentId: number;
    commenterName: string;
    bookTitle: string;
    commentPreview: string;
  };
  'post-like': { userId: number; postId: number; likerName: string; bookTitle: string };
  'new-recommendation': { userId: number; bookId: number; bookTitle: string };
}

export type PushJobName = keyof PushJobMap;

// ── Priorities ────────────────────────────────────────────────────────────────
// Lower number = higher priority. Mirrors EMAIL_PRIORITY for the same event types.

export const PUSH_PRIORITY: Record<PushJobName, number> = {
  'friend-request-sent': 7,
  'friend-request-accepted': 7,
  'post-comment': 7,
  'post-like': 8,
  'new-recommendation': 7,
};

// ── Queue ─────────────────────────────────────────────────────────────────────

export const pushQueue = new Queue('pushes', {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 }, // keep last 100 completed jobs for Bull Board
    removeOnFail: { count: 500 }, // keep last 500 failed jobs for inspection
  },
});

// ── Type-safe enqueue helper ──────────────────────────────────────────────────

export async function enqueuePush<K extends PushJobName>(
  name: K,
  data: PushJobMap[K],
): Promise<void> {
  await pushQueue.add(name, data, { priority: PUSH_PRIORITY[name] });
}
