import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * POST /books/:id/restock-requests — the HTTP layer. The rules about which
 * books qualify are pinned against a real database in
 * restock-requests.integration.test.ts; this covers what reaches the service:
 * the optional form, the honeypot, and a signed-in customer's account.
 */

const { submit, country } = vi.hoisted(() => ({
  submit: vi.fn(),
  country: vi.fn(),
}));

vi.mock('../services/restock-requests.service', () => ({ restockRequestsService: { submit } }));
vi.mock('../services/commerce/pricing', () => ({ resolveRequestCountry: country }));

import { restockRequestsController } from '../controllers/restock-requests.controller';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function call(id: string, body: unknown, user?: { id: number }) {
  const res = fakeRes();
  await restockRequestsController.submit({ params: { id }, body, user } as never, res as never);
  return res;
}

beforeEach(() => {
  submit.mockReset().mockResolvedValue({ reference: 'RR001' });
  country.mockReset().mockResolvedValue('GH');
});

describe('POST /books/:id/restock-requests', () => {
  it('accepts an empty body, and says nothing about the reference', async () => {
    const res = await call('42', {});
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ requested: true });
    expect(submit).toHaveBeenCalledWith({ bookId: 42, userId: null, name: null, email: null, country: 'GH' });
  });

  it('accepts a missing body, as a client posting nothing sends', async () => {
    const res = await call('42', undefined);
    expect(res.statusCode).toBe(201);
  });

  it('trims the form, and treats cleared fields as not given', async () => {
    await call('42', { name: '  Amara Diallo ', email: '' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Amara Diallo', email: null }));
  });

  it('passes a signed-in customer\'s account through', async () => {
    await call('42', {}, { id: 7 });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });

  it('rejects an email that is not one', async () => {
    const res = await call('42', { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a bad book id', async () => {
    for (const id of ['abc', '0', '-3', '1.5']) {
      const res = await call(id, {});
      expect(res.statusCode).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('answers a filled honeypot with a 201 and stores nothing', async () => {
    const res = await call('42', { website: 'http://spam.example' });
    expect(res.statusCode).toBe(201);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('restock helpers', async () => {
  // The service is mocked above for the controller; these are its real helpers.
  const { restockReference, shortFormat, restockEligibility } = await vi.importActual<
    typeof import('../services/restock-requests.service')
  >('../services/restock-requests.service');

  it('pads references like report references', () => {
    expect(restockReference(1)).toBe('RR001');
    expect(restockReference(1234)).toBe('RR1234');
  });

  it('labels the two common bindings the way the design does', () => {
    expect(shortFormat('BC')).toBe('Paperback');
    expect(shortFormat('BB')).toBe('Hardcover');
    expect(shortFormat('BH')).toBe("Child's board book");
    expect(shortFormat(null)).toBeNull();
  });

  describe('which editions can be requested', () => {
    const outOfStock = { isRemoved: false, isbn13: '9780000000000', rrpGbp: '9.99', stockQty: 0, reportCode: null };

    it('accepts an out-of-stock edition', () => {
      expect(restockEligibility(outOfStock, null)).toBeNull();
      expect(restockEligibility(outOfStock, false)).toBeNull();
    });

    it('accepts reprinting and out of stock indefinitely, even with stock on the row', () => {
      for (const reportCode of ['R/P', 'RP', 'OSI', ' osi ']) {
        expect(restockEligibility({ ...outOfStock, stockQty: 4, reportCode }, null)).toBeNull();
      }
    });

    it('refuses codes no restock can answer', () => {
      for (const reportCode of ['O/P', 'OP', 'CNC', 'NYP', 'POS', 'REF']) {
        expect(restockEligibility({ ...outOfStock, reportCode }, null)).toBe('UNAVAILABLE');
      }
    });

    it('refuses what can already be ordered', () => {
      expect(restockEligibility({ ...outOfStock, stockQty: 3 }, null)).toBe('IN_STOCK');
      expect(restockEligibility({ ...outOfStock, reportCode: 'GXC' }, null)).toBe('IN_STOCK');
      expect(restockEligibility({ ...outOfStock, reportCode: 'M/D' }, null)).toBe('IN_STOCK');
    });

    it('calls a restricted edition restricted, in stock or not', () => {
      expect(restockEligibility(outOfStock, true)).toBe('MARKET_RESTRICTED');
      expect(restockEligibility({ ...outOfStock, stockQty: 3 }, true)).toBe('MARKET_RESTRICTED');
    });

    it('refuses what is not on sale at all', () => {
      expect(restockEligibility(undefined, null)).toBe('BOOK_NOT_FOUND');
      expect(restockEligibility({ ...outOfStock, isRemoved: true }, null)).toBe('BOOK_NOT_FOUND');
      expect(restockEligibility({ ...outOfStock, isbn13: null }, null)).toBe('BOOK_NOT_FOUND');
      expect(restockEligibility({ ...outOfStock, rrpGbp: null }, null)).toBe('NOT_FOR_SALE');
      expect(restockEligibility({ ...outOfStock, rrpGbp: '0' }, null)).toBe('NOT_FOR_SALE');
    });
  });
});
