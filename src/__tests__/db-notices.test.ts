import { describe, it, expect, vi, afterEach } from 'vitest';
import { onNotice } from '../db/notices';

// Searches for stop words ("the", "a") make Postgres raise a NOTICE that the
// default postgres.js handler prints to stdout — once per search, from every
// short word typed into Community search. Only those are dropped.

describe('database notice handler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops the empty text-search notices', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    onNotice({ severity: 'NOTICE', code: '00000', message: "text-search query contains only stop words or doesn't contain lexemes, ignored" });
    onNotice({ severity: 'NOTICE', code: '00000', message: 'text-search query doesn\'t contain lexemes: ""' });
    expect(log).not.toHaveBeenCalled();
  });

  it('prints every other notice as postgres.js does by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const notice = { severity: 'NOTICE', code: '42P07', message: 'relation "posts" already exists, skipping' };
    onNotice(notice);
    expect(log).toHaveBeenCalledWith(notice);
  });
});
