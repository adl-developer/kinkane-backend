import { sgMail, FROM } from '../../lib/sendgrid';

export async function sendTrialEndingEmail(to: string, name: string, daysLeft: number): Promise<void> {
  await sgMail.send({
    to,
    from: FROM,
    subject: `Your Kinkané Plus trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: `
      <p>Hi ${name},</p>
      <p>Your Kinkané Plus trial will end in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>.</p>
      <p>During your trial, you've enjoyed:</p>
      <ul>
        <li>Personalised recommendations tailored to your reading tastes</li>
        <li>Unlimited bookshelf saves</li>
        <li>Community features</li>
        <li>Curated reading collections</li>
      </ul>
      <p>To continue discovering books chosen just for you, upgrade to Kinkané Plus before your trial expires.</p>
      <p><a href="https://kinkane.com/subscribe" style="background:#1a1a1a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Upgrade to Plus</a></p>
      <p>Your next great read is waiting.</p>
      <p>The Kinkané Team</p>
    `,
    text: `Hi ${name},\n\nYour Kinkané Plus trial will end in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.\n\nDuring your trial, you've enjoyed:\n• Personalised recommendations tailored to your reading tastes\n• Unlimited bookshelf saves\n• Community features\n• Curated reading collections\n\nTo continue discovering books chosen just for you, upgrade to Kinkané Plus before your trial expires.\n\nhttps://kinkane.com/subscribe\n\nYour next great read is waiting.\n\nThe Kinkané Team`,
  });
}
