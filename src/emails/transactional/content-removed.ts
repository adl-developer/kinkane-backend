import { sendEmail, FROM } from '../../lib/resend';
import { config } from '../../config';
import { emailLayout, greeting, signOff, escapeHtml, p, noticePanel, noticeDetails, appealButton } from '../lib/layout';

export type RemovedContentKind = 'post' | 'comment' | 'review';

const LABEL: Record<RemovedContentKind, string> = { post: 'Post', comment: 'Comment', review: 'Review' };

/** "12 Oct 2026" — the design's date, in the house locale. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Sent to the author when a moderator removes a post, comment or review — the
 * "Post/Comment/Review removal notice" on the Email Template page.
 *
 * The Community Guidelines are named but not linked: there is no page to link
 * to yet.
 */
export async function sendContentRemovedEmail(
  to: string,
  name: string,
  kind: RemovedContentKind,
  submittedAt: string,
): Promise<void> {
  const contact = config.email.contactFrom;
  const subject = `Your ${kind} has been removed`;
  const submittedOn = formatDate(submittedAt);

  const lines = {
    intro: `We're writing to let you know that a ${kind} you submitted on Kinkané has been removed by our moderation team.`,
    why: 'After reviewing the flagged content, we determined that it did not meet the standards set out in our Community Guidelines. To keep Kinkané a welcoming and thoughtful space for all readers, the content has been taken down and is no longer visible on the platform.',
    notSuspension: 'This is not a suspension of your account. However, repeated violations may result in further action. We encourage you to review our guidelines before posting again.',
    appeal: 'If you believe this was a mistake or would like to contest this decision, our team is happy to take another look. Simply reach out to us directly.',
    guidelines: "For a full overview of what is and isn't allowed on our platform, please read our Community Guidelines.",
  };

  const body = [
    greeting(escapeHtml(name)),
    p(`We're writing to let you know that a <strong style="color:#262626;">${kind}</strong> you submitted on Kinkané has been removed by our moderation team.`),
    p(escapeHtml(lines.why)),
    noticePanel(
      'Content removed',
      noticeDetails([
        { label: 'Type', value: LABEL[kind] },
        { label: 'Submitted on', value: submittedOn },
        { label: 'Reason for removal', value: 'Violation of Community Guidelines' },
      ]),
    ),
    p(escapeHtml(lines.notSuspension)),
    p(escapeHtml(lines.appeal)),
    appealButton(contact, subject),
    p(escapeHtml(lines.guidelines), true),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(`Your ${kind} has been removed`, body, undefined, { eyebrow: 'Community notice' }),
    text: [
      `Hi ${name},`,
      lines.intro,
      lines.why,
      `CONTENT REMOVED\nType: ${LABEL[kind]}\nSubmitted on: ${submittedOn}\nReason for removal: Violation of Community Guidelines`,
      lines.notSuspension,
      `${lines.appeal}\nEmail ${contact} with the subject "Appeal the decision: ${subject}".`,
      lines.guidelines,
      'The Kinkané Team',
    ].join('\n\n'),
  });
}
