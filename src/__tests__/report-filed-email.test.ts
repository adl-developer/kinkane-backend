import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendReportFiledEmail,
  reasonAndNotes,
  filedAtLabel,
  excerptOf,
  personLabel,
  reportsConsoleUrl,
  EXCERPT_LIMIT,
  type ReportFiledPayload,
} from '../emails/transactional/report-filed';
import { config } from '../config';

type Sent = { to: string; from: string; subject: string; html: string; text: string; replyTo?: string };
const sent: Sent[] = [];

vi.mock('../lib/resend', () => ({
  FROM: 'Kinkané <no-reply@kinkane.app>',
  sendEmail: async (msg: Sent) => {
    sent.push(msg);
  },
}));

const BASE = {
  reference: 'R014',
  reporter: { name: 'Kofi Mensah', username: 'kofi' },
  reasonCategory: 'Harassment',
  reason: 'Keeps messaging me after I asked them to stop.',
  filedAt: '2026-10-24T15:37:00.000Z',
};

const USER: ReportFiledPayload = { ...BASE, category: 'user', reportedUser: { name: 'Ama Owusu', username: 'ama_reads' } };

beforeEach(() => {
  sent.length = 0;
});

describe('report filed: staff email', () => {
  it('goes to the reports inbox from the contact address', async () => {
    await sendReportFiledEmail(USER);
    const [msg] = sent;
    expect(msg.to).toBe(config.email.reportsInbox);
    expect(msg.from).toContain(`<${config.email.contactFrom}>`);
    expect(msg.replyTo).toBeUndefined();
  });

  it('a user report: the design subject, title and every field', async () => {
    await sendReportFiledEmail(USER);
    const { subject, html, text } = sent[0];
    expect(subject).toBe('[Alert] A user has been reported on Kinkané');
    expect(html).toContain('A user has been reported');
    expect(html).toContain('Admin Alert');
    expect(text).toContain('Reported user: Ama Owusu (@ama_reads)');
    expect(text).toContain('Reported by: Kofi Mensah (@kofi)');
    expect(text).toContain('Reason: Harassment');
    expect(text).toContain('Reported on: 24 Oct 2026, 15:37 GMT');
    expect(text).toContain('Additional notes from reporter: Keeps messaging me after I asked them to stop.');
    expect(text).toContain('Reference: R014');
  });

  it('a content report: names the kind, the author, and quotes the text', async () => {
    await sendReportFiledEmail({
      ...BASE,
      reference: 'CR003',
      category: 'content',
      author: { name: 'Ama Owusu', username: null },
      contentKind: 'review',
      excerpt: 'This book is trash and so is @kofi',
    });
    const { subject, html, text } = sent[0];
    expect(subject).toBe('[Alert] A review has been reported');
    expect(html).toContain('A review has been reported');
    expect(text).toContain('Content type: Review');
    expect(text).toContain('Author: Ama Owusu');
    expect(html).toContain('Flagged content preview');
    expect(text).toContain('"This book is trash and so is @kofi"');
  });

  it('a content report whose text is gone says so instead of quoting nothing', async () => {
    await sendReportFiledEmail({
      ...BASE,
      category: 'content',
      author: { name: 'Ama', username: null },
      contentKind: 'comment',
      excerpt: null,
    });
    expect(sent[0].text).toContain('"No longer available"');
  });

  it('a group report: group, owner and member count', async () => {
    await sendReportFiledEmail({
      ...BASE,
      reference: 'GR002',
      category: 'group',
      groupName: 'Accra Thriller Club',
      owner: { name: 'Yaw Boateng', username: 'yaw' },
      memberCount: 42,
    });
    const { subject, text } = sent[0];
    expect(subject).toBe('[Alert] A group has been reported on Kinkané');
    expect(text).toContain('Group name: Accra Thriller Club');
    expect(text).toContain('Group owner: Yaw Boateng (@yaw)');
    expect(text).toContain('Group members: 42');
  });

  it('escapes everything a user wrote — the reported person chooses some of it', async () => {
    await sendReportFiledEmail({
      ...BASE,
      category: 'content',
      author: { name: '<img src=x onerror=alert(1)>', username: null },
      contentKind: 'post',
      excerpt: '<script>alert("x")</script>',
    });
    const { html } = sent[0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links to the reports page in the admin console', async () => {
    await sendReportFiledEmail(USER);
    expect(reportsConsoleUrl()).toBe(`${config.adminConsoleUrl}/reports`);
    expect(sent[0].html).toContain(`href="${config.adminConsoleUrl}/reports"`);
  });
});

describe('report filed: helpers', () => {
  it('an old app build sends only typed text: it is the reason, with no notes', () => {
    expect(reasonAndNotes({ reasonCategory: null, reason: 'Spam links' })).toEqual({ reason: 'Spam links', notes: null });
  });

  it('notes that only repeat the picked reason are none', () => {
    expect(reasonAndNotes({ reasonCategory: 'Spam', reason: 'Spam' })).toEqual({ reason: 'Spam', notes: null });
  });

  it('shows the time on Accra’s clock', () => {
    expect(filedAtLabel('2026-01-05T09:05:00.000Z')).toBe('5 Jan 2026, 09:05 GMT');
  });

  it('cuts long text at a word, with an ellipsis', () => {
    const long = 'word '.repeat(100);
    const cut = excerptOf(long);
    expect(cut.length).toBeLessThanOrEqual(EXCERPT_LIMIT + 1);
    expect(cut.endsWith('word…')).toBe(true);
    expect(excerptOf('  short\n\ntext ')).toBe('short text');
  });

  it('labels someone without a username by name alone', () => {
    expect(personLabel({ name: 'Ama', username: null })).toBe('Ama');
  });
});
