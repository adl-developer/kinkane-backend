import { sendEmail } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, ctaButton, escapeHtml, p } from '../lib/layout';
import { activeCampaign, emailCopy, emailPlainText } from '../../lib/referral-copy';

/**
 * "Jason via Kinkané <hello@kinkane.app>" — the sender's name in the display
 * position, our domain in the address.
 *
 * The copy is written in the first person ("come with me", "my link") but never
 * says who "me" is, so without this the recipient gets a personal-sounding note
 * from a brand they have never heard of. This is the standard mailing-list
 * pattern and spoofs nothing: the address stays ours, so SPF/DKIM/DMARC are
 * unaffected.
 *
 * The name is user-controlled and lands in a mail header, so it is sanitised
 * rather than interpolated: CR/LF would allow header injection outright, and
 * quotes or angle brackets would break the RFC 5322 parse and could reshape the
 * address itself.
 */
function fromWithReferrer(referrerName: string): string {
  const safe = referrerName
    .replace(/[\r\n]+/g, ' ')
    .replace(/["<>,;:\\]/g, '')
    .trim()
    .slice(0, 60);

  return safe
    ? `${safe} via ${config.email.fromName} <${config.email.from}>`
    : `${config.email.fromName} <${config.email.from}>`;
}

// No unsubscribe link, and deliberately so: the recipient is not a Kinkané user
// and has no preferences to switch off. This is a one-shot message a person
// chose to send to someone they know — the unsubscribe footer exists for mail we
// send on our own initiative, and offering it here would show a stranger a
// preferences page for an account that doesn't exist.
//
// No greeting() or signOff() either, unlike every other template in this folder.
// The copy is written as one person speaking to another and supplies its own
// "Hey!" and "Happy reading!" — wrapping it in "Hi <name>," and "The Kinkané
// Team" would make a personal note read like a system notification.

/**
 * Builds the message without sending it.
 *
 * Split out from the send so the rendered result can be asserted and eyeballed
 * — this is campaign copy with meaningful whitespace and typography, and "does
 * it actually look right" is not a question the send path can answer.
 */
export function renderReferralInvite(
  referrerName: string,
  link: string,
): { from: string; subject: string; html: string; text: string } {
  const campaign = activeCampaign();
  const copy = emailCopy(campaign);

  const body = [
    // Line breaks inside a copy paragraph are meaningful — the evergreen body
    // deliberately runs two lines together — so they survive as <br>.
    ...copy.before.map((para) => p(escapeHtml(para).replace(/\n/g, '<br>'))),
    ctaButton(copy.ctaLabel, link),
    ...copy.after.map((para) => p(escapeHtml(para))),
    p(
      `<span style="color:#6b7280;font-size:13px">If the button doesn’t work, paste this into your browser:<br>${escapeHtml(link)}</span>`,
    ),
  ].join('\n');

  return {
    // The sender's name rides in the From display name, because the subject and
    // body are campaign copy held verbatim and neither of them says who sent it.
    from: fromWithReferrer(referrerName),
    subject: copy.subject,
    html: emailLayout(copy.subject, body),
    text: emailPlainText(copy, link),
  };
}

export async function sendReferralInviteEmail(
  to: string,
  referrerName: string,
  link: string,
): Promise<void> {
  await sendEmail({ to, ...renderReferralInvite(referrerName, link) });
}
