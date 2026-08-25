import { describe, it, expect } from 'vitest';
import { UNSUBSCRIBE_FLAGS } from '../services/notification-preferences.service';
import { EMAIL_PRIORITY, type EmailJobName } from '../lib/email-queue';
import * as emails from '../emails';

/**
 * What the one-click unsubscribe link is allowed to switch off.
 *
 * The rule these guard: unsubscribe covers promotional email only — the
 * newsletter, book recommendations, reading reminders. Follow requests,
 * trial-ending, billing and security email keep sending, because they are
 * either another person contacting the user or something about their own
 * account they need to see.
 *
 * A previous version of the route cleared `friendRequests` too, while telling
 * the user on the confirmation page that only "marketing and notification"
 * email would stop. Someone who unsubscribed from a newsletter silently
 * stopped hearing that people wanted to follow them. That is the regression
 * this file exists to prevent.
 */
describe('unsubscribe scope', () => {
  it('clears exactly the three promotional flags', () => {
    expect([...UNSUBSCRIBE_FLAGS].sort()).toEqual([
      'marketingEmails',
      'newBookSuggestions',
      'rateReviewReminders',
    ]);
  });

  it('never clears friendRequests — a follow request is not marketing', () => {
    expect(UNSUBSCRIBE_FLAGS).not.toContain('friendRequests');
  });

  it('never clears the social flags, which gate push rather than email', () => {
    expect(UNSUBSCRIBE_FLAGS).not.toContain('likes');
    expect(UNSUBSCRIBE_FLAGS).not.toContain('comments');
  });
});

/**
 * Social activity notifies by push and the in-app feed, never by email.
 *
 * The templates and queue cases for these existed for months while nothing
 * enqueued them — one wired-up call site away from mailing users on every
 * like. Asserting on the job map keeps the absence deliberate: you cannot
 * enqueue what has no job name.
 */
describe('no email channel for social activity', () => {
  it('has no post-like or post-comment email job', () => {
    const jobNames = Object.keys(EMAIL_PRIORITY) as EmailJobName[];
    expect(jobNames).not.toContain('post-like' as EmailJobName);
    expect(jobNames).not.toContain('post-comment' as EmailJobName);
  });

  it('exports no sender for post likes or comments', () => {
    expect(emails).not.toHaveProperty('sendPostLikeEmail');
    expect(emails).not.toHaveProperty('sendPostCommentEmail');
  });
});

/**
 * Every job in the queue must have a priority, or enqueueEmail passes
 * `priority: undefined` and the job silently loses its place in the queue.
 * Cheap guard, and the two maps are edited in separate places.
 */
describe('email queue wiring', () => {
  it('assigns a priority to every job name', () => {
    for (const [name, priority] of Object.entries(EMAIL_PRIORITY)) {
      expect(priority, `${name} has no priority`).toBeTypeOf('number');
    }
  });
});
