import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, escapeHtml, p } from '../lib/layout';

export async function sendAccountDeletedEmail(to: string, name: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = "We're sorry to see you go";

  const body = [
    p(`Hi ${safeName},`),
    p('Your Kinkané account has been successfully deleted.'),
    p('Your reading history, saved books, and account information have been removed in accordance with our data policies.'),
    p('Thank you for being part of the Kinkané community. We hope to see you again someday.'),
    p('Happy reading,'),
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nYour Kinkané account has been successfully deleted.\n\nYour reading history, saved books, and account information have been removed in accordance with our data policies.\n\nThank you for being part of the Kinkané community. We hope to see you again someday.\n\nHappy reading,\nThe Kinkané Team`,
  });
}
