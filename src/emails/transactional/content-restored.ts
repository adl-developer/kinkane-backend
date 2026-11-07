import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeDetails, contactLink } from '../lib/layout';
import type { RemovedContentKind } from './content-removed';

const LABEL: Record<RemovedContentKind, string> = { post: 'Post', comment: 'Comment', review: 'Review' };

/** "12 Oct 2026" — the design's date, in the house locale. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Sent to the author when a moderator unhides a post, comment or review — the
 * "Post, comment, review restored" frame on the Email Template page.
 *
 * `visible` is false for a post that was private before it was hidden: it goes
 * back to private, so the email does not promise the community can see it.
 */
export async function sendContentRestoredEmail(
  to: string,
  name: string,
  kind: RemovedContentKind,
  submittedAt: string,
  visible: boolean,
): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = `Your ${kind} has been restored`;
  const submittedOn = formatDate(submittedAt);
  const status = visible ? 'Restored — visible to the community' : 'Restored';

  const restoredTail = visible ? 'it has been restored and is now visible on Kinkané again.' : 'it has been restored.';
  const lines = {
    intro: `We've completed our review of your ${kind} that was previously removed, and we're pleased to let you know that ${restoredTail}`,
    why: 'After a careful second look, we determined that the content did not violate our Community Guidelines. We apologise for any inconvenience the removal may have caused.',
    contact: "If you have any questions or concerns, don't hesitate to get in touch with us at",
  };

  const body = [
    greeting(escapeHtml(name)),
    p(`We've completed our review of your <strong style="color:#262626;">${kind}</strong> that was previously removed, and we're pleased to let you know that ${restoredTail}`),
    p(escapeHtml(lines.why)),
    noticePanel(
      'Content restored',
      noticeDetails([
        { label: 'Type', value: LABEL[kind] },
        { label: 'Originally submitted on', value: submittedOn },
        { label: 'Status', value: status, accent: 'restored' },
      ]),
      'restored',
    ),
    p(`${escapeHtml(lines.contact)} ${contactLink(contact)}.`, true),
    signOff(undefined, 'The Kinkané Trust &amp; Safety Team'),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(subject, body, undefined, { eyebrow: 'Community notice', tone: 'restored' }),
    text: [
      `Hi ${name},`,
      lines.intro,
      lines.why,
      `CONTENT RESTORED\nType: ${LABEL[kind]}\nOriginally submitted on: ${submittedOn}\nStatus: ${status}`,
      `${lines.contact} ${contact}.`,
      'The Kinkané Trust & Safety Team',
    ].join('\n\n'),
  });
}
