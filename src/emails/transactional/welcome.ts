import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Welcome to Kinkané';

  const body = [
    p(`Hi ${safeName},`),
    p('Welcome to Kinkané,'),
    p("We're excited to help you discover books you'll actually love — not just what's trending."),
    p('The more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.'),
    p('Your next favourite book might be closer than you think.'),
    ctaButton('Explore Your Bookshelf', 'https://kinkane.com'),
    p('Happy reading,'),
    p('<strong>The Kinkané Team</strong>', true),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${name},\n\nWelcome to Kinkané,\n\nWe're excited to help you discover books you'll actually love — not just what's trending.\n\nThe more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.\n\nYour next favourite book might be closer than you think.\n\nhttps://kinkane.com\n\nHappy reading,\nThe Kinkané Team`,
  });
}
