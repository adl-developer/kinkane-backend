import { sendEmail, FROM } from '../../lib/resend';
import { appLink } from '../../lib/app-link';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeBullets, ctaButton } from '../lib/layout';

/**
 * Sent when a moderator lifts a blacklist — the counterpart to the
 * account-blacklisted notice, undoing each of its lines. Posts, reviews, shelf
 * and orders were never touched, so they come back as they were; sessions were
 * revoked, so the reader has to sign in again.
 */
export async function sendAccountReinstatedEmail(to: string, name: string): Promise<void> {
  const subject = 'Your account has been reinstated';

  const lines = {
    intro: "Good news: following a further review by our Trust & Safety team, the blacklist on your Kinkané account has been lifted.",
    restored: 'Your access to Kinkané has been fully restored, and your bookshelf, posts, reviews and order history are just as you left them.',
    means: [
      'You can sign in to the app again. You were signed out of every device when the blacklist was applied, so you will need to sign in once more.',
      'Your profile and community activity are visible to other members again.',
      'You can purchase books on the Kinkané bookstore again.',
    ],
    guidelines: 'To help keep Kinkané a welcoming place for every reader, please take a moment to review our Community Guidelines. We are glad to have you back.',
  };

  const body = [
    greeting(escapeHtml(name)),
    p(escapeHtml(lines.intro)),
    p(escapeHtml(lines.restored)),
    noticePanel('What this means for your account', noticeBullets(lines.means)),
    ctaButton('Open Kinkané', appLink()),
    p(escapeHtml(lines.guidelines), true),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(subject, body, undefined, { eyebrow: 'Account notice' }),
    text: [
      `Hi ${name},`,
      lines.intro,
      lines.restored,
      `WHAT THIS MEANS FOR YOUR ACCOUNT\n${lines.means.map((m) => `• ${m}`).join('\n')}`,
      appLink(),
      lines.guidelines,
      'The Kinkané Team',
    ].join('\n\n'),
  });
}
