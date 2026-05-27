import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config';
import type { RecommendedBook, NewsletterPayload, WeeklyDigestPayload } from '../emails';

// BullMQ requires maxRetriesPerRequest: null — a separate connection from the
// main redis instance (which uses maxRetriesPerRequest: 1 for rate limiting).
export const bullConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ── Job payload types ─────────────────────────────────────────────────────────

export interface EmailJobMap {
  'welcome':            { to: string; name: string };
  'password-reset':     { to: string; name: string; resetUrl: string };
  'trial-ending':       { to: string; name: string; daysLeft: number };
  'new-recommendation': { to: string; name: string; books: RecommendedBook[] };
  'newsletter':         { to: string; payload: NewsletterPayload };
  'weekly-digest':      { to: string; payload: WeeklyDigestPayload };
}

export type EmailJobName = keyof EmailJobMap;

// ── Priorities ────────────────────────────────────────────────────────────────
// Lower number = higher priority. Password reset is critical (user is blocked).

export const EMAIL_PRIORITY: Record<EmailJobName, number> = {
  'password-reset':     1,
  'welcome':            5,
  'trial-ending':       5,
  'new-recommendation': 7,
  'weekly-digest':      8,
  'newsletter':         10,
};

// ── Queue ─────────────────────────────────────────────────────────────────────

export const emailQueue = new Queue('emails', {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 }, // keep last 100 completed jobs for Bull Board
    removeOnFail:     { count: 500 }, // keep last 500 failed jobs for inspection
  },
});

// ── Type-safe enqueue helper ──────────────────────────────────────────────────

export async function enqueueEmail<K extends EmailJobName>(
  name: K,
  data: EmailJobMap[K],
): Promise<void> {
  await emailQueue.add(name, data, { priority: EMAIL_PRIORITY[name] });
}
