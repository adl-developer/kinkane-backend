import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Readers like you loved" — the cohort rail.
 *
 * Every property asserted here is one that breaks *silently*: the rail keeps
 * rendering books, nobody sees an error, and the list is quietly wrong or
 * quietly leaking. So they are asserted against the query text, the way
 * feed-prices.test.ts does — these are properties of the SQL, including the
 * ones about what it must not contain.
 *
 * The behaviour itself (ranking, exclusions, edition collapse, pagination) was
 * verified against a seeded cohort on a real database; see
 * changelog/2026-09-15-reader-type-feed.md.
 */

const source = readFileSync(join(__dirname, '..', 'services/books.service.ts'), 'utf8');

// The method body, bounded by the two method signatures either side of it, so
// these assertions can't be satisfied by some other feed's SQL further down.
const method = source.slice(
  source.indexOf('async likedByReaderType('),
  source.indexOf('async basketRecommendations('),
);

describe('reader-type cohort feed', () => {
  it('is present and bounded', () => {
    expect(method).toContain('WITH cohort AS');
    expect(method.length).toBeGreaterThan(500);
  });

  it('never selects a liker identity', () => {
    // THE privacy property. The cohort is read regardless of shelf_visibility,
    // and that is only defensible while the response is an anonymous aggregate.
    // The moment a name, a photo or even a count reaches the client, a shelf set
    // to private becomes reconstructable from a cohort of one — so this must
    // fail loudly before that ships, not after.
    const selected = method.slice(method.indexOf('SELECT representative.id'));
    expect(selected).not.toMatch(/person_name|photo_url|\buser_id\b/);
    expect(selected).not.toMatch(/users\.name|\bemail\b/);
  });

  it('does not leak the liker count into the response', () => {
    // liker_count is the ranking key and must stay server-side: it is a count of
    // real people's private shelves. The row type the controller serialises is
    // the check — if liker_count ever appears there, it is going out over the wire.
    const rowType = source.slice(
      source.indexOf('interface ReaderTypeFeedRow'),
      source.indexOf('}', source.indexOf('interface ReaderTypeFeedRow')),
    );
    expect(rowType).toContain('liker_count');
    const controller = readFileSync(
      join(__dirname, '..', 'controllers/explore.controller.ts'),
      'utf8',
    );
    const handler = controller.slice(controller.indexOf('async getReaderTypeLikes('));
    expect(handler).not.toContain('liker_count');
    expect(handler).not.toContain('likerCount');
  });

  it('excludes the caller from their own cohort', () => {
    // "Readers like you" means other readers. Without this a book the caller
    // alone liked appears in a rail claiming other people loved it. Applied as a
    // fragment now the endpoint is public: a signed-out visitor has no identity
    // to exclude, and `<> undefined` would exclude everyone.
    expect(method).toMatch(/users\.id}\s*<>\s*\${userId}/);
    expect(method).toContain('userId === undefined ? sql`` :');
    expect(method).toContain('${selfFilter}');
  });

  it('is public, and degrades rather than failing when signed out', () => {
    // The route takes optionalAuth, so userId is genuinely absent for a visitor.
    // Every per-caller narrowing has to be skipped rather than applied to
    // undefined — an exclusion query keyed on undefined would either throw or,
    // worse, quietly filter on nothing recognisable.
    const routes = readFileSync(join(__dirname, '..', 'routes/explore.routes.ts'), 'utf8');
    expect(routes).toContain("router.get('/reader-type', optionalAuth");
    expect(routes).not.toMatch(/router\.get\('\/reader-type', requireAuth/);
    expect(method).toContain('userId: number | undefined');
    expect(method).toContain('userId === undefined ? EMPTY_EXCLUSIONS : await getUserExclusions(userId)');
  });

  it('counts each supporter once, not once per signal', () => {
    // A shelf row can be liked AND read AND a quiz pick at the same time. COUNT(*)
    // would score that person three times and hand the top of the rail to
    // whoever happens to trip the most flags.
    expect(method).toMatch(/COUNT\(DISTINCT user_id\)/);
    expect(method).not.toMatch(/COUNT\(\*\)::int AS liker_count/);
  });

  it('accepts all three positive signals', () => {
    // Explicit likes alone are Plus-only, and a rail built on them would be
    // near-empty for most reader types. Dropping any one of these shrinks the
    // pool without any visible failure.
    expect(method).toContain('${userBooks.liked}');
    expect(method).toMatch(/userBooks\.status}\s*=\s*'read'/);
    expect(method).toContain("'chosen_from_onboarding', 'chosen_from_quiz'");
  });

  it('scores works rather than catalogue rows', () => {
    // The subtle one. Counting per book row and collapsing editions afterwards
    // splits a well-loved title's support across its paperback, hardback and
    // ebook — the survivor then ranks below a book one person liked. Verified
    // live: before this, a work two cohort members liked across two editions
    // came back LAST behind three single-liker books.
    const workScores = method.indexOf('work_scores AS');
    const representative = method.indexOf('representative AS');
    expect(workScores).toBeGreaterThan(-1);
    expect(representative).toBeGreaterThan(workScores);
    expect(method).toMatch(/ORDER BY work_scores\.liker_count DESC/);
  });

  it('joins the work score with null-safe author matching', () => {
    // work_author is null for a catalogue row with no named A01 contributor. A
    // plain `=` drops every one of those works from the join and they vanish
    // from the rail without a word.
    expect(method).toContain('IS NOT DISTINCT FROM');
  });

  it('normalises works exactly the way the exclusion filter does', () => {
    // Two spellings of "the same book" in one codebase is how a filter quietly
    // stops matching. lib/exclusions.ts is the definition; this must copy it.
    const exclusions = readFileSync(join(__dirname, '..', 'lib/exclusions.ts'), 'utf8');
    expect(exclusions).toContain('lower(btrim(');
    expect(method).toContain('lower(btrim(${books.title}))');
  });

  it('orders deterministically so offset pagination is stable', () => {
    // Equal liker counts are common in a small cohort. Without a tiebreak,
    // Postgres may order them differently per query and paging repeats and drops
    // books — the kind of bug that only shows up on page two.
    expect(method).toMatch(/liker_count DESC, representative\.id/);
  });

  it('counts the total over the same filtered, deduped set it returns', () => {
    // A total from a separate query counts something the caller can never page
    // to. The window runs after the work collapse, on the final set.
    expect(method).toContain('COUNT(*) OVER ()::int AS total');
    expect(method.indexOf('COUNT(*) OVER ()')).toBeGreaterThan(method.indexOf('representative AS'));
  });

  it('applies the shelf and dislike exclusions', () => {
    expect(method).toContain('getUserExclusions(userId)');
    expect(method).toContain('${idFilter}');
    expect(method).toContain('${workFilter}');
  });

  it('is not cached', () => {
    // Offset pagination plus a per-page cache key means page 1 can be fresh
    // while page 2 is an hour old — which is how a reader sees the same book
    // twice while paging.
    expect(method).not.toContain('redis.set');
    expect(method).not.toContain('redis.get');
  });

  it('returns an empty page rather than throwing when there is no reader type', () => {
    expect(method).toContain('if (!cohortType) return { books: [], total: 0 };');
  });

  it('validates the reader-type override against the database enum', () => {
    // The override is interpolated into the cohort predicate, so it must never
    // arrive as a free string. Sourced from the enum rather than a hand-copied
    // list so a newly added reader type is accepted the day it lands — and so
    // this assertion breaks if someone swaps it for z.string().
    const controller = readFileSync(
      join(__dirname, '..', 'controllers/explore.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('readerType: z.enum(readerTypeEnum.enumValues).optional()');
    expect(controller).not.toMatch(/readerType:\s*z\.string\(\)/);
  });

  it('never looks a caller up when there is no caller', () => {
    // A signed-out visitor must not reach a users lookup keyed on undefined.
    expect(method).toMatch(/userId === undefined\s*\?\s*undefined/);
  });

  it('falls back to the caller’s own reader type when none is passed', () => {
    // The override widens which cohort is read, not what may be read about it:
    // the caller stays excluded from the count and their own exclusions still
    // apply, so an explicit type cannot be used to see more than the endpoint
    // would otherwise show.
    expect(method).toContain('readerType ??');
    expect(method).toMatch(/users\.id}\s*<>\s*\${userId}/);
    expect(method).toContain('getUserExclusions(userId)');
  });

  it('carries no price, and no cached price either', () => {
    // This rail is discovery, not a shop surface. If it ever gains an Add
    // button, the price must be attached per request — never cached. See the
    // note on TrendingBookItem.
    expect(method).not.toContain('attachShopFields');
  });
});
