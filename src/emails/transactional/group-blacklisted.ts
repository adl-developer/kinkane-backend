import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeBullets, appealButton } from '../lib/layout';

/**
 * Sent to a group's owner when a moderator blacklists it — the "Group removal
 * notice" on the Email Template page. Owner only: members are not emailed, the
 * group simply disappears for them.
 *
 * The Community Guidelines are named but not linked: there is no page yet.
 */
export async function sendGroupBlacklistedEmail(to: string, name: string, groupName: string): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = 'Your group has been blacklisted';

  const lines = {
    why: 'After careful review, we determined that activity within the group violated our Community Guidelines. As a result, the group has been made inaccessible to all members and will no longer appear on the platform.',
    means: [
      'The group and its content are no longer visible to members.',
      'Members will not be able to post, comment, or interact within the group.',
      'This action was taken to protect our reading community.',
    ],
    appeal: 'If you believe this decision was made in error or would like to appeal, please reach out to our team directly. We take all appeals seriously and will review your case as promptly as possible.',
    guidelines: 'You can review the full guidelines our community is held to on our Community Guidelines page.',
  };

  const body = [
    greeting(escapeHtml(name)),
    p(`We're reaching out to let you know that your group, <strong style="color:#262626;">${escapeHtml(groupName)}</strong>, has been blacklisted on Kinkané following a review by our team.`),
    p(escapeHtml(lines.why)),
    noticePanel('What this means', noticeBullets(lines.means)),
    p(escapeHtml(lines.appeal)),
    appealButton(contact, subject),
    p(escapeHtml(lines.guidelines), true),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout('Your group has been removed', body, undefined, { eyebrow: 'Community notice' }),
    text: [
      `Hi ${name},`,
      `We're reaching out to let you know that your group, ${groupName}, has been blacklisted on Kinkané following a review by our team.`,
      lines.why,
      `WHAT THIS MEANS\n${lines.means.map((m) => `• ${m}`).join('\n')}`,
      `${lines.appeal}\nEmail ${contact} with the subject "Appeal the decision: ${subject}".`,
      lines.guidelines,
      'The Kinkané Team',
    ].join('\n\n'),
  });
}
