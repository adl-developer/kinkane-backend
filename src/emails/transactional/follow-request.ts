import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';

// No unsubscribe link: follow-request mail is not part of the promotional set
// and keeps sending after a user unsubscribes, so offering the link here would
// show them a confirmation page for something it does not switch off. The
// per-user `friendRequests` toggle in Settings is how this is turned off.

export async function sendFollowRequestEmail(to: string, receiverName: string, senderName: string): Promise<void> {
  const safeReceiver = escapeHtml(receiverName);
  const safeSender = escapeHtml(senderName);
  const title = 'New follow request';

  const body = [
    greeting(safeReceiver),
    p(`<strong>${safeSender}</strong> has sent you a follow request on Kinkané.`),
    ctaButton('Open Kinkané', config.appUrl),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: `${senderName} wants to follow you on Kinkané`,
    html: emailLayout(title, body),
    text: `Hi ${receiverName},\n\n${senderName} has sent you a follow request on Kinkané.\n\nOpen the app to accept or ignore the request.\n\nThe Kinkané Team`,
  });
}

export async function sendFollowAcceptedEmail(to: string, senderName: string, accepterName: string): Promise<void> {
  const safeSender = escapeHtml(senderName);
  const safeAccepter = escapeHtml(accepterName);
  const title = 'Follow request accepted';

  const body = [
    greeting(safeSender),
    p(`<strong>${safeAccepter}</strong> has accepted your follow request on Kinkané.`),
    p('You can now see their reading activity.'),
    ctaButton('View Their Shelf', config.appUrl),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject: `${accepterName} accepted your follow request`,
    html: emailLayout(title, body),
    text: `Hi ${senderName},\n\n${accepterName} has accepted your follow request on Kinkané.\n\nYou can now see their reading activity.\n\n${config.appUrl}\n\nThe Kinkané Team`,
  });
}
