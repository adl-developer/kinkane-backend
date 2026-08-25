import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

// No unsubscribe link: this is the one-off transactional email confirming the
// account exists, sent once and never repeated, so there is nothing for an
// unsubscribe to stop.

export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const safeName = escapeHtml(name);
  const title = 'Welcome to Kinkané';

  const body = [
    greeting(safeName),
    p('Welcome to Kinkané,'),
    p("We're excited to help you discover books you'll actually love — not just what's trending."),
    p('The more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.'),
    p('Your next favourite book might be closer than you think.'),
    ctaButton('Explore Your Bookshelf', config.appUrl),
    signOff('Happy reading,'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nWelcome to Kinkané,\n\nWe're excited to help you discover books you'll actually love — not just what's trending.\n\nThe more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.\n\nYour next favourite book might be closer than you think.\n\n${config.appUrl}\n\nHappy reading,\nThe Kinkané Team`,
  });
}
