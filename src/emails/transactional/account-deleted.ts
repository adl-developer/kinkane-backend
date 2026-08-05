import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, greeting, signOff, escapeHtml, p } from '../lib/layout';

export async function sendAccountDeletedEmail(to: string, name: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = "We're sorry to see you go";

  const body = [
    greeting(safeName),
    p('Your Kinkané account has been successfully deleted.'),
    p('Your reading history, saved books, and account information have been removed in accordance with our data policies.'),
    signOff('Thank you for being part of the Kinkané community. We hope to see you again someday.'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nYour Kinkané account has been successfully deleted.\n\nYour reading history, saved books, and account information have been removed in accordance with our data policies.\n\nThank you for being part of the Kinkané community. We hope to see you again someday.\n\nThe Kinkané Team`,
  });
}
