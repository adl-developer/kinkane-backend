import { sendEmail } from '../../lib/resend';
import { escapeHtml } from '../lib/layout';
import { adminAlertLayout, alertIntro, detailsPanel, alertButton, type DetailField } from '../lib/admin-alert-layout';
import { config } from '../../config';

/** Someone named in a report, as a moderator would look them up. */
export interface ReportPerson {
  name: string;
  username: string | null;
}

/** What was reported, in the words the console uses for it. */
export type ReportedContentKind = 'post' | 'review' | 'comment';

interface ReportFiledBase {
  reference: string;
  reporter: ReportPerson;
  /** The reason the reporter picked in the app, e.g. "Harassment". */
  reasonCategory: string | null;
  /** What the reporter typed. */
  reason: string;
  /** ISO timestamp, so the payload survives the email queue as JSON. */
  filedAt: string;
}

export type ReportFiledPayload =
  | (ReportFiledBase & { category: 'user'; reportedUser: ReportPerson })
  | (ReportFiledBase & {
      category: 'content';
      author: ReportPerson;
      contentKind: ReportedContentKind;
      /** The reported text, mentions rendered, or null if it is already gone. */
      excerpt: string | null;
    })
  | (ReportFiledBase & {
      category: 'group';
      groupName: string;
      owner: ReportPerson | null;
      memberCount: number;
    });

/** How long a quoted post or comment may run before it is cut. */
export const EXCERPT_LIMIT = 280;

/** "Amara Diallo (@amara)", or just the name for someone without a username. */
export function personLabel(p: ReportPerson): string {
  return p.username ? `${p.name} (@${p.username})` : p.name;
}

/**
 * The design has a "Reason" and an "Additional notes" field, but older app
 * builds send only the typed reason. When there is no picked reason, the typed
 * one is the reason and there are no notes, rather than "Reason: —" above the
 * text it should have been. Notes that only repeat the picked reason are none.
 */
export function reasonAndNotes(p: Pick<ReportFiledBase, 'reasonCategory' | 'reason'>): {
  reason: string;
  notes: string | null;
} {
  const typed = p.reason.trim();
  if (!p.reasonCategory) return { reason: typed, notes: null };
  return { reason: p.reasonCategory, notes: typed && typed !== p.reasonCategory.trim() ? typed : null };
}

/**
 * When it was filed, on Accra's clock — the team's — and saying so, since
 * admins may read it elsewhere. "24 Oct 2026, 15:37 GMT".
 */
export function filedAtLabel(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Accra' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Accra' });
  return `${date}, ${time} GMT`;
}

/** Cut at a word boundary under the limit, with an ellipsis. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  const cut = flat.slice(0, EXCERPT_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_LIMIT * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The console's reports page. The console lives in the web app
 * (ADMIN_CONSOLE_URL), not on this server. Exported for the tests.
 */
export function reportsConsoleUrl(): string {
  return `${config.adminConsoleUrl}/reports`;
}

const NOUN: Record<ReportedContentKind, string> = { post: 'post', review: 'review', comment: 'comment' };

/** Subject, title and opening line per kind of report — the Figma copy. */
function wording(p: ReportFiledPayload): { subject: string; title: string; intro: string } {
  switch (p.category) {
    case 'user':
      return {
        subject: '[Alert] A user has been reported on Kinkané',
        title: 'A user has been reported',
        intro:
          'A member of the Kinkané community has been reported by another user. The report is pending review in your admin dashboard.',
      };
    case 'content':
      return {
        subject: `[Alert] A ${NOUN[p.contentKind]} has been reported`,
        title: `A ${NOUN[p.contentKind]} has been reported`,
        intro:
          'A piece of community content has been flagged by a member. The report is awaiting your review in the admin dashboard.',
      };
    case 'group':
      return {
        subject: '[Alert] A group has been reported on Kinkané',
        title: 'A group has been reported',
        intro:
          'A community group on Kinkané has been reported by a member. The report is pending review in your admin dashboard.',
      };
  }
}

/** The details panel's fields, in the design's order, as plain text. */
function fields(p: ReportFiledPayload): { label: string; value: string; wide?: boolean }[] {
  const { reason, notes } = reasonAndNotes(p);
  const reporter = personLabel(p.reporter);
  const filedAt = filedAtLabel(p.filedAt);
  // The design has no reference, but it is what the console shows on each row,
  // so it is how the email is matched to the report it is about.
  const reference = { label: 'Reference', value: p.reference };

  switch (p.category) {
    case 'user':
      return [
        { label: 'Reported user', value: personLabel(p.reportedUser) },
        { label: 'Reported by', value: reporter },
        { label: 'Reason', value: reason },
        { label: 'Reported on', value: filedAt },
        { label: 'Additional notes from reporter', value: notes ?? 'None provided', wide: true },
        reference,
      ];
    case 'content':
      return [
        { label: 'Content type', value: NOUN[p.contentKind].replace(/^./, (c) => c.toUpperCase()) },
        { label: 'Author', value: personLabel(p.author) },
        { label: 'Reported by', value: reporter },
        { label: 'Reported on', value: filedAt },
        { label: 'Reason', value: reason },
        reference,
        // Not in the content design, which has no notes field; shown only when
        // there are some, because dropping what the reporter wrote would leave
        // the moderator with less than the report says.
        ...(notes ? [{ label: 'Additional notes from reporter', value: notes, wide: true }] : []),
      ];
    case 'group':
      return [
        { label: 'Group name', value: p.groupName },
        { label: 'Group owner', value: p.owner ? personLabel(p.owner) : 'Unknown' },
        { label: 'Reported by', value: reporter },
        { label: 'Reported on', value: filedAt },
        { label: 'Reason', value: reason },
        { label: 'Group members', value: String(p.memberCount) },
        { label: 'Additional notes from reporter', value: notes ?? 'None provided', wide: true },
        reference,
      ];
  }
}

/** The subject and both bodies, without sending. Exported for previews. */
export function buildReportFiledEmail(payload: ReportFiledPayload): { subject: string; html: string; text: string } {
  const { subject, title, intro } = wording(payload);
  const list = fields(payload);
  const url = reportsConsoleUrl();
  const excerpt =
    payload.category === 'content'
      ? payload.excerpt
        ? excerptOf(payload.excerpt)
        : 'No longer available'
      : null;

  const panelFields: DetailField[] = list.map((f) => ({ ...f, value: escapeHtml(f.value) }));
  const body = [
    alertIntro(escapeHtml(intro)),
    detailsPanel(panelFields, excerpt !== null ? { label: 'Flagged content preview', text: escapeHtml(excerpt) } : undefined),
    alertButton('Review in admin dashboard', url),
  ].join('\n');

  return {
    subject,
    html: adminAlertLayout('New report', escapeHtml(title), body),
    text: [
      title,
      '',
      intro,
      '',
      ...list.map((f) => `${f.label}: ${f.value}`),
      ...(excerpt !== null ? ['', 'Flagged content preview:', `"${excerpt}"`] : []),
      '',
      `Review in admin dashboard: ${url}`,
      '',
      'Kinkané Admin System',
    ].join('\n'),
  };
}

/**
 * The staff alert for one new report, to REPORTS_INBOX.
 *
 * From EMAIL_CONTACT_FROM, like the restock alert: it is staff mail, and
 * replies should stay with the contact address. Everything the reporter or the
 * reported person wrote is escaped — a report is the one email whose content
 * is chosen by the person being complained about.
 */
export async function sendReportFiledEmail(payload: ReportFiledPayload): Promise<void> {
  await sendEmail({
    to: config.email.reportsInbox,
    from: `${config.email.fromName} <${config.email.contactFrom}>`,
    ...buildReportFiledEmail(payload),
  });
}
