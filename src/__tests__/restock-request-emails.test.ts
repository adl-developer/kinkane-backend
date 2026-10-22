import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requesterLabel,
  sendRestockRequestAdminEmail,
  sendRestockRequestCustomerEmail,
  type RestockEmailBook,
} from '../emails/transactional/restock-request';
import { config } from '../config';

type Sent = { to: string; from: string; subject: string; html: string; text: string; replyTo?: string };
const sent: Sent[] = [];

vi.mock('../lib/resend', () => ({
  FROM: 'Kinkané <no-reply@kinkane.app>',
  sendEmail: async (msg: Sent) => {
    sent.push(msg);
  },
}));

const BOOK: RestockEmailBook = {
  title: 'Wandering Stars',
  author: 'Tommy Orange',
  format: 'Paperback',
  coverUrl: 'https://res.cloudinary.com/demo/cover.jpg',
  url: 'https://kinkane.app/books/812',
};

beforeEach(() => {
  sent.length = 0;
});

describe('restock request: staff email', () => {
  it('goes to the restock inbox, from the contact address, with no reply-to', async () => {
    await sendRestockRequestAdminEmail({ reference: 'RR001', name: 'Amara Diallo', email: 'amara@example.com', book: BOOK });
    const [msg] = sent;
    expect(msg.to).toBe(config.email.restockInbox);
    expect(msg.from).toContain(`<${config.email.contactFrom}>`);
    expect(msg.replyTo).toBeUndefined();
    expect(msg.subject).toBe('Restock request: Wandering Stars (Paperback)');
  });

  it('says who asked, shows the book, links it, and asks for the publisher to be contacted', async () => {
    await sendRestockRequestAdminEmail({ reference: 'RR001', name: 'Amara Diallo', email: 'amara@example.com', book: BOOK });
    const { html, text } = sent[0];
    expect(text).toContain('Amara Diallo (amara@example.com) has requested a restocking of this book:');
    expect(html).toContain(BOOK.coverUrl);
    expect(html).toContain('Wandering Stars (Paperback)');
    expect(html).toContain('by Tommy Orange');
    expect(html).toContain(`href="${BOOK.url}"`);
    expect(text).toContain('Please contact your publisher to request restocking of the book.');
    expect(text).toContain('Reference: RR001');
  });

  it('escapes what the customer typed', async () => {
    await sendRestockRequestAdminEmail({ reference: 'RR002', name: '<img src=x onerror=alert(1)>', email: null, book: BOOK });
    expect(sent[0].html).not.toContain('<img src=x');
    expect(sent[0].html).toContain('&lt;img src=x');
  });

  it('copes with a book that has no cover or author', async () => {
    await sendRestockRequestAdminEmail({
      reference: 'RR003', name: null, email: null,
      book: { ...BOOK, coverUrl: null, author: null, format: null },
    });
    expect(sent[0].html).not.toContain('alt="Wandering Stars');
    expect(sent[0].text).toContain('by Author unknown');
    expect(sent[0].subject).toBe('Restock request: Wandering Stars');
  });
});

describe('who asked', () => {
  it('names them as fully as they allowed', () => {
    expect(requesterLabel('Amara Diallo', 'amara@example.com')).toBe('Amara Diallo (amara@example.com)');
    expect(requesterLabel('Amara Diallo', null)).toBe('Amara Diallo');
    expect(requesterLabel(null, 'amara@example.com')).toBe('amara@example.com');
    expect(requesterLabel(null, null)).toBe('A customer');
  });
});

describe('restock request: customer email', () => {
  it('comes from the no-reply sender, to the customer', async () => {
    await sendRestockRequestCustomerEmail('amara@example.com', 'Amara', BOOK);
    expect(sent[0].to).toBe('amara@example.com');
    expect(sent[0].from).toBe('Kinkané <no-reply@kinkane.app>');
  });

  it('confirms the request without promising to tell them when it is back', async () => {
    await sendRestockRequestCustomerEmail('amara@example.com', 'Amara', BOOK);
    const { text, html } = sent[0];
    expect(text).toMatch(/^Hi Amara,/);
    expect(text).toContain('They’ll be in touch if they can get it back in stock.');
    expect(text).not.toMatch(/we.ll (let you know|notify)/i);
    expect(html).toContain('Wandering Stars (Paperback)');
  });

  it('greets someone who gave no name', async () => {
    await sendRestockRequestCustomerEmail('amara@example.com', null, BOOK);
    expect(sent[0].text).toMatch(/^Hi there,/);
  });
});
