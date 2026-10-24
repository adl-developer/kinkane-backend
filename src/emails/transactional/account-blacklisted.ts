import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeBullets, appealButton } from '../lib/layout';

/**
 * Sent when a moderator blacklists an account — the "User blacklist notice" on
 * the Email Template page. Every promise in it is what a blacklist does: the
 * community is closed to them, the bookstore is not.
 *
 * The Community Guidelines are named but not linked: there is no page yet.
 */
export async function sendAccountBlacklistedEmail(to: string, name: string): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = 'Your account has been blacklisted';

  const lines = {
    intro: "We're reaching out to let you know that your Kinkané account has been blacklisted following a review by our Trust & Safety team.",
    why: 'After careful review, we found that your account was involved in activity that violates our Community Guidelines. As a result, your access to Kinkané has been suspended. You will not be able to use the platform, with the exception of browsing and purchasing books on the bookstore.',
    means: [
      'You will not be able to post, comment, or leave reviews on the platform.',
      'You will not be able to create or participate in community groups.',
      'Your profile and existing community activity will no longer be visible to other members.',
      'You will not have access to community features or social areas of Kinkané.',
      'You can still browse and purchase books on the Kinkané bookstore.',
    ],
    appeal: "We understand this may come as a surprise. If you believe this decision was made in error, or if you'd like to understand more about why this action was taken, we encourage you to reach out to our team. We review every appeal carefully.",
    guidelines: 'To understand what conduct is expected of all members, please review our Community Guidelines.',
  };

  const body = [
    greeting(escapeHtml(name)),
    p(escapeHtml(lines.intro)),
    p(escapeHtml(lines.why)),
    noticePanel('What this means for your account', noticeBullets(lines.means)),
    p(escapeHtml(lines.appeal)),
    appealButton('Appeal this decision', contact),
    p(escapeHtml(lines.guidelines), true),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout('Your account has been blacklisted', body, undefined, { eyebrow: 'Account notice' }),
    text: [
      `Hi ${name},`,
      lines.intro,
      lines.why,
      `WHAT THIS MEANS FOR YOUR ACCOUNT\n${lines.means.map((m) => `• ${m}`).join('\n')}`,
      `${lines.appeal}\nAppeal this decision: ${contact}`,
      lines.guidelines,
      'The Kinkané Team',
    ].join('\n\n'),
  });
}
