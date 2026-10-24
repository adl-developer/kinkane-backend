import { sendEmail, FROM } from '../../lib/resend';
import { emailLayout, signOff, escapeHtml, p, noticePanel, noticeBullets } from '../lib/layout';

/**
 * Sent to the house inbox when a blacklisted account's groups pass to the
 * Kinkané Admin account, so someone knows the clubs now need looking after and
 * who ran them before. Internal, so plain: no greeting, no appeal button.
 */
export async function sendGroupsHandedOverEmail(
  to: string,
  formerOwnerName: string,
  formerOwnerEmail: string,
  groups: { id: number; name: string }[],
): Promise<void> {
  const subject =
    groups.length === 1 ? `Group handed over to Kinkané Admin: ${groups[0].name}` : `${groups.length} groups handed over to Kinkané Admin`;
  const intro = `${formerOwnerName} (${formerOwnerEmail}) has been blacklisted. The groups they owned now belong to the Kinkané Admin account. ${formerOwnerName} stays in each group as a hidden member, and ownership stays with Kinkané Admin if the blacklist is lifted.`;
  const list = groups.map((g) => `${g.name} (group ${g.id})`);

  const body = [
    p(escapeHtml(intro)),
    noticePanel(groups.length === 1 ? 'Group handed over' : 'Groups handed over', noticeBullets(list)),
    p('To hand a group back or to someone else, change its owner from the admin side.', true),
    signOff(),
  ].join('\n');

  await sendEmail({
    to,
    from: FROM,
    subject,
    html: emailLayout(escapeHtml(subject), body, undefined, { eyebrow: 'Admin notice' }),
    text: [intro, list.map((l) => `• ${l}`).join('\n'), 'To hand a group back or to someone else, change its owner from the admin side.', 'The Kinkané Team'].join('\n\n'),
  });
}
