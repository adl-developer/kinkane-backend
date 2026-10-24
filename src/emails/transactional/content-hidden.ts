import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p } from '../lib/layout';

export type HiddenContentKind = 'review' | 'post' | 'comment';

/** Sent to the author when a moderator hides something they wrote. */
export async function sendContentHiddenEmail(
  to: string,
  name: string,
  kind: HiddenContentKind,
  bookTitle: string | null,
): Promise<void> {
  const safeName = escapeHtml(name);
  const what = bookTitle ? `your ${kind} on ${bookTitle}` : `your ${kind}`;
  const title = `We've hidden your ${kind}`;

  const lines = [
    `Someone reported ${what}. We've looked at it, and we've hidden it because it goes against our community guidelines.`,
    `You can still see it, but no one else can.`,
    `If you think we got this wrong, reply to this email and we'll take another look.`,
  ];

  const body = [
    greeting(safeName),
    p(escapeHtml(lines[0])),
    p(lines[1]),
    p(lines[2]),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\n${lines.join('\n\n')}\n\nThe Kinkané Team`,
  });
}
