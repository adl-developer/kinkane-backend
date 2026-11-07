import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeBullets, contactLink } from '../lib/layout';

/**
 * Sent to a group's owner when a moderator lifts its blacklist — the "Group
 * restored" frame on the Email Template page. Owner only, as with the
 * blacklist notice. "A further review" rather than the design's "a review of
 * your appeal", since a blacklist can be lifted unasked.
 *
 * The Community Guidelines are named but not linked: there is no page yet.
 */
export async function sendGroupRestoredEmail(to: string, name: string, groupName: string): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = 'Your group has been restored';

  const lines = {
    intro: `We're writing to let you know that your group, ${groupName}, has been restored on Kinkané. Following a further review, we've lifted the blacklist and the group is now accessible to its members again.`,
    apology: 'We apologise for any disruption to your group and its members during this time.',
    restored: [
      'The group is visible and accessible to all its members.',
      'Members can post, comment, and interact within the group again.',
      'Group content and history have been preserved.',
    ],
    guidelines: 'As group owner, we ask that you continue to ensure the group upholds our Community Guidelines. If you have any questions, reach us at',
  };

  const body = [
    greeting(escapeHtml(name)),
    p(`We're writing to let you know that your group, <strong style="color:#262626;">${escapeHtml(groupName)}</strong>, has been restored on Kinkané. Following a further review, we've lifted the blacklist and the group is now accessible to its members again.`),
    p(escapeHtml(lines.apology)),
    noticePanel("What's been restored", noticeBullets(lines.restored, 'restored'), 'restored'),
    p(`${escapeHtml(lines.guidelines)} ${contactLink(contact)}.`, true),
    signOff(undefined, 'The Kinkané Trust &amp; Safety Team'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(subject, body, undefined, { eyebrow: 'Community notice', tone: 'restored' }),
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
