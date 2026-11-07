import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeBullets, contactLink } from '../lib/layout';

/**
 * Sent when a moderator lifts a blacklist — the "User restored" frame on the
 * Email Template page. The design says "following a review of your appeal";
 * this says "a further review", since a blacklist can be lifted unasked.
 *
 * The Community Guidelines are named but not linked: there is no page yet.
 */
export async function sendAccountRestoredEmail(to: string, name: string): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = 'Your account has been restored';

  const lines = {
    intro: "We're glad to let you know that your Kinkané account has been fully restored. Following a further review, we've lifted the blacklist on your account and your access to the platform has been reinstated.",
    apology: 'We apologise for any disruption this caused. You can now use Kinkané as normal.',
    restored: [
      'Full access to all community features and spaces.',
      'Ability to post, comment, and leave reviews.',
      'Ability to create and participate in groups.',
      'Your profile and community activity are visible again.',
    ],
    guidelines: 'We ask that you continue to uphold the standards of our Community Guidelines as you engage with the Kinkané community. If you have any further questions, reach us at',
  };

  const body = [
    greeting(escapeHtml(name)),
    p(escapeHtml(lines.intro)),
    p(escapeHtml(lines.apology)),
    noticePanel("What's been restored", noticeBullets(lines.restored, 'restored'), 'restored'),
    p(`${escapeHtml(lines.guidelines)} ${contactLink(contact)}.`, true),
    signOff(undefined, 'The Kinkané Trust &amp; Safety Team'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(subject, body, undefined, { eyebrow: 'Account notice', tone: 'restored' }),
    text: [
      `Hi ${name},`,
      lines.intro,
      lines.apology,
      `WHAT'S BEEN RESTORED\n${lines.restored.map((m) => `• ${m}`).join('\n')}`,
      `${lines.guidelines} ${contact}.`,
      'The Kinkané Trust & Safety Team',
    ].join('\n\n'),
  });
}
