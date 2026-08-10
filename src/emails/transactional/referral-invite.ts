import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, signOff, escapeHtml, p } from '../lib/layout';

// No unsubscribe link, and deliberately so: the recipient is not a Kinkané user
// and has no preferences to switch off. This is a one-shot message a person
// chose to send to someone they know — the unsubscribe footer exists for mail we
// send on our own initiative, and offering it here would show a stranger a
// preferences page for an account that doesn't exist.

export async function sendReferralInviteEmail(
  to: string,
  referrerName: string,
  link: string,
  videoUrl: string,
): Promise<void> {
  const safeName = escapeHtml(referrerName);
  const title = `${referrerName} invited you to Kinkané`;

  const body = [
    p(`<strong>${safeName}</strong> thinks you'd like Kinkané — books picked for how you actually read, not for what's selling this week.`),
    p(`<a href="${escapeHtml(videoUrl)}">Watch the 60-second intro</a>`),
    ctaButton('Accept the invitation', link),
    p(
      `<span style="color:#6b7280;font-size:13px">If the button doesn't work, paste this into your browser:<br>${escapeHtml(link)}</span>`,
    ),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text:
      `${referrerName} thinks you'd like Kinkané — books picked for how you actually read.\n\n` +
      `Watch the intro: ${videoUrl}\n\n` +
      `Accept the invitation: ${link}\n\n` +
      `The Kinkané Team`,
  });
}
