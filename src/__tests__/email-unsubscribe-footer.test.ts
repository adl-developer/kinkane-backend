import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Which emails carry an Unsubscribe link in their footer.
 *
 * The link must appear on exactly the mail the unsubscribe route can actually
 * stop. Two ways to get this wrong, and both had shipped:
 *
 *  - The newsletter — the one genuinely promotional email — rendered no
 *    unsubscribe link at all, which is the CAN-SPAM/GDPR failure mode.
 *  - Follow-request, welcome and trial-ending rendered one, even though they
 *    keep sending afterwards, which is the "link does nothing" failure mode.
 */

const sent: { to: string; html: string }[] = [];

vi.mock('../lib/sendgrid', () => ({
  sgMail: {
    send: async (msg: { to: string; html: string }) => {
      sent.push(msg);
    },
  },
  FROM: 'test@kinkane.com',
}));

// A stable secret so unsubscribeUrl can sign a token during the test run.
vi.mock('../config', () => ({
  config: {
    appUrl: 'https://kinkane.com',
    apiUrl: 'https://api.kinkane.com',
    jwt: { secret: 'test-secret' },
    unsubscribeSecret: 'test-secret',
  },
}));

import { sendNewsletterEmail } from '../emails/marketing/newsletter';
import { sendWelcomeEmail } from '../emails/transactional/welcome';
import { sendFollowRequestEmail } from '../emails/transactional/follow-request';
import { sendTrialEndingEmail } from '../emails/notifications/trial-ending';

const lastHtml = () => sent[sent.length - 1].html;
const hasUnsubscribeLink = (html: string) => html.includes('>Unsubscribe</a>');

beforeEach(() => {
  sent.length = 0;
});

describe('promotional email', () => {
  it('newsletter renders an unsubscribe link', async () => {
    await sendNewsletterEmail('reader@example.com', {
      subject: 'This month at Kinkané',
      title: 'This month at Kinkané',
      htmlBody: '<p>Books.</p>',
      textBody: 'Books.',
    });

    expect(hasUnsubscribeLink(lastHtml())).toBe(true);
  });
});

describe('non-promotional email', () => {
  it('welcome renders no unsubscribe link', async () => {
    await sendWelcomeEmail('reader@example.com', 'Ama');
    expect(hasUnsubscribeLink(lastHtml())).toBe(false);
  });

  it('follow request renders no unsubscribe link', async () => {
    await sendFollowRequestEmail('reader@example.com', 'Ama', 'Kofi');
    expect(hasUnsubscribeLink(lastHtml())).toBe(false);
  });

  it('trial ending renders no unsubscribe link', async () => {
    await sendTrialEndingEmail('reader@example.com', 'Ama', 3);
    expect(hasUnsubscribeLink(lastHtml())).toBe(false);
  });

  it('still renders the privacy and terms footer links', async () => {
    await sendWelcomeEmail('reader@example.com', 'Ama');
    expect(lastHtml()).toContain('Privacy Notice');
    expect(lastHtml()).toContain('Terms of Use');
  });
});
