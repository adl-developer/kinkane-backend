import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from '../config';
import type {
  RecommendedBook, NewsletterPayload, WeeklyDigestPayload, OrderConfirmedPayload,
} from '../emails';

// BullMQ requires maxRetriesPerRequest: null — a separate connection from the
// main redis instance (which uses maxRetriesPerRequest: 1 for rate limiting).
export const bullConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ── Job payload types ─────────────────────────────────────────────────────────

export interface EmailJobMap {
  'welcome':            { to: string; name: string };
  'verify-email':       { to: string; name: string; otp: string; expiryMinutes?: number };
  'password-reset':     { to: string; name: string; resetUrl: string };
  'password-changed':   { to: string; name: string };
  'account-deleted':    { to: string; name: string };
  'trial-ending':       { to: string; name: string; daysLeft: number };
  'new-recommendation': { to: string; name: string; book: RecommendedBook };
  'newsletter':         { to: string; payload: NewsletterPayload };
  'weekly-digest':      { to: string; payload: WeeklyDigestPayload };
  'email-change-otp':   { to: string; name: string; otp: string; expiryMinutes?: number };
  'email-change-notify':{ to: string; name: string; cancelUrl: string };
  'follow-request':       { to: string; receiverName: string; senderName: string };
  'follow-accepted':      { to: string; senderName: string; accepterName: string };
  'rate-review-reminder': { to: string; name: string; book: { title: string; author: string; url: string } };
  // No post-like / post-comment jobs by design: social activity notifies via
  // push and the in-app feed only, never email. See community.service.ts.
  'subscription-confirmed':     { to: string; name: string; plan: 'monthly' | 'annual'; isFounding: boolean; currentPeriodEnd: string | null };
  'subscription-payment-failed':{ to: string; name: string; amountCents: number | null; currency: string | null };
  'subscription-cancelled':     { to: string; name: string; accessEndsAt: string | null };
  // No videoUrl: the campaign copy has no slot for it, and the copy set in
  // force is decided at send time rather than baked into the job.
  'referral-invite':            { to: string; referrerName: string; link: string };
  'order-confirmed':            { to: string; name: string | null; payload: OrderConfirmedPayload };
}

export type EmailJobName = keyof EmailJobMap;

// ── Priorities ────────────────────────────────────────────────────────────────
// Lower number = higher priority. Password reset is critical (user is blocked).

export const EMAIL_PRIORITY: Record<EmailJobName, number> = {
  // Highest of the transactional set: somebody has just been charged, and for a
  // guest this email is the only copy of their tracking code that will ever
  // exist. It must not queue behind a newsletter.
  'order-confirmed':    1,
  'password-reset':     1,
  'password-changed':   1,
  'account-deleted':    1,
  'welcome':            5,
  'verify-email':       3,
  'trial-ending':       5,
  'new-recommendation': 7,
  'weekly-digest':      8,
  'newsletter':         10,
  'email-change-otp':   1,
  'email-change-notify':1,
  'follow-request':       7,
  'follow-accepted':      7,
  'rate-review-reminder': 7,
  // Billing mail is as critical as password mail — a payment failure the user
  // doesn't see becomes a cancellation they didn't choose.
  'subscription-confirmed':     1,
  'subscription-payment-failed':1,
  'subscription-cancelled':     1,
  // A person is standing in the app waiting to see the invite land in their
  // friend's inbox, which puts it above digests but below anything a user is
  // actually blocked on.
  'referral-invite':            5,
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
  opts?: { delayMs?: number },
): Promise<void> {
  await emailQueue.add(name, data, {
    priority: EMAIL_PRIORITY[name],
    ...(opts?.delayMs ? { delay: opts.delayMs } : {}),
  });
}
