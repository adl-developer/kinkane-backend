import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildFeedCondition } from '../services/books.service';
import { UNSUPPLIABLE_REPORT_CODES } from '../lib/shoppable';

/**
 * No recommendation surface may offer a book the shop cannot sell.
 *
 * The filter used to be opt-in per feed, gated on the caller passing
 * `shoppable=true`, and a client that forgot it got recommendations with an Add
 * button that 409s at the cart. Two of the paths never applied it at all. It is
 * now a property of recommending, not of asking to shop.
 *
 * The point of a test here is that this is an invariant across *seven* separate
 * queries in four files, each of which builds its own WHERE. Nothing in the type
 * system stops the eighth from being written without it, so the assertions below
 * are deliberately about each query site rather than about one shared helper.
 */

const dialect = new PgDialect();
const feedSql = dialect.sqlToQuery(buildFeedCondition()).sql.toLowerCase();

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const booksService = read('services/books.service.ts');
const recommendationsService = read('services/recommendations.service.ts');
const notificationsService = read('services/recommendation-notifications.service.ts');
const bestsellersService = read('services/commerce/bestsellers.service.ts');
const booksController = read('controllers/books.controller.ts');
const exploreController = read('controllers/explore.controller.ts');

describe('buildFeedCondition', () => {
  it('excludes withdrawn titles', () => {
    expect(feedSql).toContain('"is_removed"');
  });

  it('excludes what the shop cannot sell', () => {
    // Same three exclusions as the catalogue-side filter: no ISBN13, no live
    // supplier price, or a report code that says it cannot be supplied.
    expect(feedSql).toContain('"books"."isbn13" is not null');
    expect(feedSql).toContain('gs.rrp_gbp > 0');
    expect(feedSql).toContain('"gardners_stock"');
  });

  it('carries the shared unsuppliable code list rather than its own', () => {
    // A second copy of these codes is the drift lib/shoppable exists to prevent:
    // a code added to one list and not the other leaves a title recommended and
    // unbuyable, with nothing to notice it by.
    const params = dialect.sqlToQuery(buildFeedCondition()).params;
    for (const code of UNSUPPLIABLE_REPORT_CODES) {
      expect(params).toContain(code);
    }
  });

  it('takes no argument, so no caller can opt out of it', () => {
    // The signature is the enforcement. While it read `buildFeedCondition(shoppable)`
    // every call site was a chance to pass nothing and silently get the
    // unfiltered catalogue — which is exactly what the bestseller chart and the
    // default-off feeds were doing.
    expect(buildFeedCondition.length).toBe(0);
    expect(booksService).not.toMatch(/buildFeedCondition\(\s*shoppable\s*\)/);
    expect(bestsellersService).not.toMatch(/buildFeedCondition\(\s*shoppable\s*\)/);
  });
});

describe('every recommendation query applies it', () => {
  it('covers all four feeds in books.service', () => {
    // trending's fallback top-up, trending's hydration, basketRecommendations,
    // similar — plus personalized, asserted separately below because it is the
    // one that never had it.
    const uses = booksService.match(/buildFeedCondition\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it('covers the personalized feed, which never filtered at all', () => {
    // This query built its own WHERE and skipped the shared predicate, so the
    // one feed explicitly framed as recommendations could surface both withdrawn
    // and unsellable books.
    const method = booksService.slice(
      booksService.indexOf('async personalized('),
      booksService.indexOf('async basketRecommendations('),
    );
    expect(method).toContain('buildFeedCondition()');
  });

  it('covers the basket carousel', () => {
    const method = booksService.slice(
      booksService.indexOf('async basketRecommendations('),
      booksService.indexOf('async similar('),
    );
    expect(method).toContain('buildFeedCondition()');
  });

  it('covers the onboarding quiz, whose books are the first a reader sees', () => {
    // Shared with the feeds rather than restated, so the quiz cannot drift from
    // them on what sellable means.
    expect(recommendationsService).toContain("import { buildFeedCondition } from './books.service'");
    const conditions = recommendationsService.slice(
      recommendationsService.indexOf('function buildBaseConditions('),
      recommendationsService.indexOf('export function buildPreferenceText('),
    );
    expect(conditions).toContain('buildFeedCondition()');
  });

  it('covers the unprompted recommendation email', () => {
    // The one surface the reader did not ask for, so a dead-end pick costs the
    // most trust.
    const picker = notificationsService.slice(
      notificationsService.indexOf('export async function pickUnsentRecommendation('),
    );
    expect(picker).toContain('buildFeedCondition()');
  });

  it('covers the bestseller chart and its trending fallback', () => {
    expect(bestsellersService).toContain('buildFeedCondition()');
  });
});

describe('shoppable', () => {
  // Sliced to the closing brace at column zero — basketRecsSchema contains a
  // nested `transform((v, ctx) => { ... })`, so the first `});` is not the end
  // of the schema.
  const schemaSlice = (source: string, start: string) => {
    const from = source.indexOf(start);
    expect(from, `no ${start} in source`).toBeGreaterThan(-1);
    const end = source.indexOf('\n});', from);
    return source.slice(from, end === -1 ? undefined : end);
  };

  it('is not a parameter of any recommendation endpoint', () => {
    // The client asks for nothing. These surfaces exist to sell, so they always
    // return sellable books and always price them — there is no unpriced variant
    // to select, and no flag a client can forget. Asserted on the schemas
    // because the schema is the contract: a parameter absent from it is a
    // parameter the endpoint does not have.
    const recommendationSchemas = [
      schemaSlice(booksController, 'const similarSchema'),
      schemaSlice(booksController, 'const basketRecsSchema'),
      schemaSlice(exploreController, 'const limitSchema'),
      schemaSlice(exploreController, 'const bestsellersSchema'),
    ];

    for (const schema of recommendationSchemas) {
      expect(schema).not.toContain('shoppable');
    }
  });

  it('is gone from the feed services too, not just hidden behind the controllers', () => {
    // A parameter still threaded through the service is one a future controller
    // can start passing again, which is how the flag came to mean two different
    // things in the first place.
    for (const method of ['async trending(', 'async personalized(', 'async similar(']) {
      const signature = booksService.slice(
        booksService.indexOf(method),
        booksService.indexOf('{', booksService.indexOf(method)),
      );
      expect(signature, method).not.toContain('shoppable');
    }
    expect(bestsellersService).not.toMatch(/shoppable\??:\s*boolean/);
  });

  it('survives on the catalogue listing, where it ranks rather than prices', () => {
    // `GET /books` is the one place the flag still means something: it bands the
    // page in shop order instead of filtering, so it must keep both its
    // parameter and its `false` default — removing it there would silently
    // reorder every browse and search request.
    expect(schemaSlice(booksController, 'const listSchemaBase')).toMatch(
      /shoppable: z\.enum\(\['true', 'false'\]\)\.default\('false'\)/,
    );
  });

  it('busts the personalized feed under the key that feed actually writes', () => {
    // Not strictly about sellability, but it is the same failure and this
    // change renamed the key: the buster deleted `personalized:v1:` for the
    // whole life of the v2 key, so a user's rejected books sat in their feed for
    // the full hour. Both sides are asserted against the same literal.
    const exclusions = read('lib/exclusions.ts');
    const prefix = /const PERSONALIZED_CACHE_PREFIX = '(personalized:v\d+:)';/.exec(exclusions);
    expect(prefix, 'no PERSONALIZED_CACHE_PREFIX in exclusions.ts').not.toBeNull();
    expect(booksService).toContain(`const cacheKey = \`${prefix![1]}$`);
  });

  it('leaves every feed row priced, with no flag gating it', () => {
    // attachShopFields used to return the rows untouched when the caller had not
    // asked to shop, which is how a carousel ended up with cards it had no price
    // for. The only early return left is the empty list.
    const helper = booksService.slice(booksService.indexOf('async function attachShopFields'));
    expect(helper).toContain('if (items.length === 0) return items;');
    expect(helper).not.toContain('!shoppable');
  });
});
