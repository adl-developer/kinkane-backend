import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p } from '../lib/layout';

/** Sent to the owner and every member when a moderator blacklists a group. */
export async function sendGroupBlacklistedEmail(
  to: string,
  name: string,
  groupName: string,
  isOwner: boolean,
): Promise<void> {
  const safeName = escapeHtml(name);
  const title = isOwner ? `Your group ${groupName} has been suspended` : `${groupName} has been suspended`;

  const lines = [
    isOwner
      ? `Your group ${groupName} was reported. We've looked at it, and we've suspended it because it goes against our community guidelines.`
      : `${groupName}, a group you're in, was reported. We've looked at it, and we've suspended it because it goes against our community guidelines.`,
    `While it's suspended, you won't be able to open the group, and it won't appear in search. Nothing in it has been deleted.`,
    isOwner
      ? `If you think we got this wrong, reply to this email and we'll take another look.`
      : `You don't need to do anything.`,
  ];

  const body = [greeting(safeName), ...lines.map((l) => p(escapeHtml(l))), signOff()].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(escapeHtml(title), body),
    text: `Hi ${name},\n\n${lines.join('\n\n')}\n\nThe Kinkané Team`,
  });
}
