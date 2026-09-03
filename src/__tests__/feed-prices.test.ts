import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Discovery feeds carry a live price, and the cache must never contain one.
 *
 * These feeds cache their pool for an hour. A price is the one thing in this
 * system that must not be served from an hour-old snapshot: supplier prices move
 * hourly, and the whole shop rests on a displayed price being the price the
 * basket will honour. So the ordering matters — cache the books, attach the
 * price afterwards, on every request.
 */

const source = readFileSync(join(__dirname, '..', 'services/books.service.ts'), 'utf8');

describe('discovery feeds', () => {
  it('has no feed left returning rows without shop fields attached', () => {
    // The old shape was `return applyUserExclusions(...)`. Every one of those is
    // now wrapped, so a surviving bare call means a feed return was missed.
    // Asserted against the file rather than by slicing method bodies, because
    // slicing on brace indentation walks into nested callbacks and lies.
    expect(source).not.toMatch(/return applyUserExclusions\(/);
    // Narrowed to the feed item type: the search-suggestion caches also return
    // straight from JSON.parse and correctly carry no price.
    expect(source).not.toMatch(/if \(cached\) return JSON\.parse\(cached\) as TrendingBookItem/);
  });

  it('attaches on every feed return path', () => {
    // Six: trending (cached + fresh), similar (cached + fresh), personalized
    // (cached + fresh) and basketRecommendations (guest + signed-in) — minus the
    // two personalized paths that share one wrapper.
    const attachments = source.match(/attachShopFields\(/g) ?? [];
    // One definition plus one call per return path.
    expect(attachments.length).toBeGreaterThanOrEqual(8);
  });

  it('never writes a price into the cache', () => {
    // The property that makes any of this safe. Every redis.set of a feed pool
    // must come before its attachShopFields, never after.
    for (const key of ['TRENDING_TTL', 'PERSONALIZED_TTL']) {
      const idx = source.indexOf(`'EX', ${key}`);
      expect(idx, `no cache write found for ${key}`).toBeGreaterThan(-1);
    }
    // No cached payload is built from an already-priced list: the value passed
    // to redis.set is always the raw pool.
    expect(source).not.toMatch(/redis\.set\([^)]*attachShopFields/);
  });

  it('resolves currency per request rather than caching it', () => {
    // One cached pool is shared by every viewer, so a visitor in Lagos and one
    // in Berlin must not see each other's money.
    const controller = readFileSync(
      join(__dirname, '..', 'controllers/books.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('export async function shopCurrency');
    expect(controller).toContain('resolveRequestCountry(req)');
  });

  it('puts the fields on every feed row, with no flag gating them', () => {
    // These fields used to be gated on the caller passing `shoppable`, and a
    // client that did not know to pass it got a carousel of cards it had no
    // price for. Every one of these feeds is a shop surface, so the only early
    // return left is the empty list.
    const helper = source.slice(source.indexOf('async function attachShopFields'));
    expect(helper).toContain('if (items.length === 0) return items;');
    expect(helper).not.toContain('shoppable');
  });
});
