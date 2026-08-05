import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

// No unsubscribe link: a trial that is about to convert to a paid subscription
// is account state the user needs to know about, so this sends regardless of
// the promotional opt-out and must not imply otherwise.

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

export async function sendTrialEndingEmail(to: string, name: string, daysLeft: number): Promise<void> {
  const safeName = escapeHtml(name);
  const plural = daysLeft === 1 ? '' : 's';
  const title = `Your Kinkané Plus trial ends in ${daysLeft} day${plural}`;

  const featureList = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 4px;">
    <tr><td style="padding:4px 0;font-family:${SANS};font-size:14px;color:#52514E;line-height:22.75px;">&#8226;&nbsp; Personalised recommendations tailored to your reading tastes</td></tr>
    <tr><td style="padding:4px 0;font-family:${SANS};font-size:14px;color:#52514E;line-height:22.75px;">&#8226;&nbsp; Unlimited bookshelf saves</td></tr>
    <tr><td style="padding:4px 0;font-family:${SANS};font-size:14px;color:#52514E;line-height:22.75px;">&#8226;&nbsp; Community features</td></tr>
    <tr><td style="padding:4px 0;font-family:${SANS};font-size:14px;color:#52514E;line-height:22.75px;">&#8226;&nbsp; Curated reading collections</td></tr>
  </table>`;

  const body = [
    greeting(safeName),
    p(`Your Kinkané Plus trial will end in <strong>${daysLeft} day${plural}</strong>.`),
    p("During your trial, you've enjoyed:"),
    featureList,
    p('To continue discovering books chosen just for you, upgrade to Kinkané Plus before your trial expires.'),
    ctaButton('Upgrade to Plus', 'https://kinkane.com/subscribe'),
    signOff('Your next great read is waiting.'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: title,
    html: emailLayout(title, body),
    text: `Hi ${name},\n\nYour Kinkané Plus trial will end in ${daysLeft} day${plural}.\n\nDuring your trial, you've enjoyed:\n• Personalised recommendations tailored to your reading tastes\n• Unlimited bookshelf saves\n• Community features\n• Curated reading collections\n\nTo continue discovering books chosen just for you, upgrade to Kinkané Plus before your trial expires.\n\nhttps://kinkane.com/subscribe\n\nYour next great read is waiting.\n\nThe Kinkané Team`,
  });
}
