import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p } from '../lib/layout';

export async function sendPasswordChangedEmail(to: string, name: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Your password was changed';

  const body = [
    greeting(safeName),
    p('This is a confirmation that your Kinkané password was successfully updated.'),
    p('If you made this change, no further action is required.'),
    signOff('If you did not change your password, please contact us immediately.'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nThis is a confirmation that your Kinkané password was successfully updated.\n\nIf you made this change, no further action is required.\n\nIf you did not change your password, please contact us immediately.\n\nThe Kinkané Team`,
  });
}
