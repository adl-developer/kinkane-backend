import { sgMail, FROM } from '../../lib/sendgrid';
import { emailLayout, ctaButton, greeting, signOff, escapeHtml, p } from '../lib/layout';
import { unsubscribeUrl } from '../../lib/unsubscribe-token';

export async function sendFollowRequestEmail(to: string, receiverName: string, senderName: string): Promise<void> {
  const safeReceiver = escapeHtml(receiverName);
  const safeSender = escapeHtml(senderName);
  const title = 'New follow request';

  const body = [
    greeting(safeReceiver),
    p(`<strong>${safeSender}</strong> has sent you a follow request on Kinkané.`),
    ctaButton('Open Kinkané', 'https://kinkane.com'),
    signOff(),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: `${senderName} wants to follow you on Kinkané`,
    html: emailLayout(title, body, unsubscribeUrl(to)),
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
    ctaButton('View Their Shelf', 'https://kinkane.com'),
    signOff(),
  ].join('\n');

  await sgMail.send({
    to,
    from: FROM,
    subject: `${accepterName} accepted your follow request`,
    html: emailLayout(title, body, unsubscribeUrl(to)),
    text: `Hi ${senderName},\n\n${accepterName} has accepted your follow request on Kinkané.\n\nYou can now see their reading activity.\n\nhttps://kinkane.com\n\nThe Kinkané Team`,
  });
}
