import { sgMail, FROM } from '../../lib/sendgrid';

/**
 * Sent immediately after a new user signs up (email/password or social).
 */
export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: 'Welcome to Kinkane 📚',
    html: `
      <p>Hi ${name},</p>
      <p>Welcome to Kinkane! We're excited to help you discover your next great read.</p>
      <p>You're currently on a <strong>90-day free trial</strong> of Kinkane Plus — enjoy unlimited recommendations, personalised picks, and more.</p>
      <p>Happy reading,<br/>The Kinkane Team</p>
    `,
    text: `Hi ${name},\n\nWelcome to Kinkane! You're on a 90-day free trial of Kinkane Plus.\n\nHappy reading,\nThe Kinkane Team`,
  });
}
