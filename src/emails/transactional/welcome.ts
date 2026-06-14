import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Welcome to Kinkané',
    html: `
      <p>Hi ${name},</p>
      <p>Welcome to Kinkané,</p>
      <p>We're excited to help you discover books you'll actually love—not just what's trending.</p>
      <p>The more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.</p>
      <p>Your next favourite book might be closer than you think.</p>
      <p>Happy reading,<br/>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nWelcome to Kinkané,\n\nWe're excited to help you discover books you'll actually love—not just what's trending.\n\nThe more you tell us about your reading tastes, the better your recommendations become. Start building your bookshelf, explore new authors, and uncover stories that match your mood and interests.\n\nYour next favourite book might be closer than you think.\n\nHappy reading,\nThe Kinkané Team`,
  });
}
