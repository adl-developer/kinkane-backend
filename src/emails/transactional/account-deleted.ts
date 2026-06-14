import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendAccountDeletedEmail(to: string, name: string): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: "We're sorry to see you go",
    html: `
      <p>Hi ${name},</p>
      <p>Your Kinkané account has been successfully deleted.</p>
      <p>Your reading history, saved books, and account information have been removed in accordance with our data policies.</p>
      <p>Thank you for being part of the Kinkané community. We hope to see you again someday.</p>
      <p>Happy reading,<br/>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nYour Kinkané account has been successfully deleted.\n\nYour reading history, saved books, and account information have been removed in accordance with our data policies.\n\nThank you for being part of the Kinkané community. We hope to see you again someday.\n\nHappy reading,\nThe Kinkané Team`,
  });
}
