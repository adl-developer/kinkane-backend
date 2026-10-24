import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendContentRemovedEmail } from '../emails/transactional/content-removed';
import { sendGroupBlacklistedEmail } from '../emails/transactional/group-blacklisted';

/**
 * The moderation notices against the Email Template designs and the client's
 * answers: the subjects and titles, the appeal button that opens a ready-made
 * email, and names and group names escaped.
 */

const sent: { to: string; subject: string; html: string; text: string }[] = [];
vi.mock('../lib/resend', () => ({
  sendEmail: async (msg: { to: string; subject: string; html: string; text: string }) => {
    sent.push(msg);
  },
  FROM: 'Kinkane <test@kinkane.com>',
}));
vi.mock('../config', () => ({
  config: {
    appUrl: 'https://kinkane.com',
    email: { contactFrom: 'contactus@kinkane.app' },
  },
}));


/** The appeal link's address and decoded subject. */
function appealLink(html: string): { address: string; subject: string } {
  const match = html.match(/href="mailto:([^"?]+)\?subject=([^"]+)"/);
  expect(match, 'no appeal mailto link').not.toBeNull();
  return { address: match![1], subject: decodeURIComponent(match![2]) };
}

beforeEach(() => {
  sent.length = 0;
});

describe('content removed notice', () => {
  it('names the kind in subject and title, with the submitted date and reason', async () => {
    await sendContentRemovedEmail('james@example.com', 'James', 'review', '2026-10-12T09:00:00Z');
    const [email] = sent;
    expect(email.subject).toBe('Your review has been removed');
    expect(email.html).toContain('Your review has been removed');
    expect(email.html).toContain('Community notice');
    expect(email.html).toContain('12 Oct 2026');
    expect(email.html).toContain('Violation of Community Guidelines');
    expect(email.text).toContain('Type: Review');
  });

  it('opens an appeal titled after this notice', async () => {
    await sendContentRemovedEmail('james@example.com', 'James', 'comment', '2026-10-12T09:00:00Z');
    expect(appealLink(sent[0].html)).toEqual({
      address: 'contactus@kinkane.app',
      subject: 'Appeal the decision: Your comment has been removed',
    });
    expect(sent[0].html).toContain('Email to contactus@kinkane.app');
  });

  it('escapes the name', async () => {
    await sendContentRemovedEmail('x@example.com', '<b>Eve</b>', 'post', '2026-10-12T09:00:00Z');
    expect(sent[0].html).not.toContain('<b>Eve</b>');
    expect(sent[0].html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
  });
});

describe('group blacklisted notice', () => {
  it('is written to the owner, with the design subject and title', async () => {
    await sendGroupBlacklistedEmail('kofi@example.com', 'Kofi', 'Midnight Fiction Collective');
    const [email] = sent;
    expect(email.subject).toBe('Your group has been blacklisted');
    expect(email.html).toContain('Your group has been removed');
    expect(email.html).toContain('your group, <strong');
    expect(appealLink(email.html).subject).toBe('Appeal the decision: Your group has been blacklisted');
  });

  it('escapes the group name, which its owner chose', async () => {
    await sendGroupBlacklistedEmail('kofi@example.com', 'Kofi', '<img src=x onerror=alert(1)>');
    expect(sent[0].html).not.toContain('<img src=x');
  });
});

describe('every notice', () => {
  it('names the Community Guidelines without linking them, as there is no page yet', async () => {
    await sendContentRemovedEmail('a@example.com', 'A', 'post', '2026-10-12T09:00:00Z');
    await sendGroupBlacklistedEmail('b@example.com', 'B', 'G');
    for (const email of sent) {
      expect(email.html).toContain('Community Guidelines');
      expect(email.html).not.toMatch(/href="[^"]*guidelines/i);
      // The address stays written under the button for clients that ignore mailto.
      expect(email.html.match(/contactus@kinkane\.app/g)!.length).toBeGreaterThanOrEqual(2);
    }
  });
});
