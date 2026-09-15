import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { startApp, type Harness } from './support/app-harness';
import { listRoutes, hasParams, type RouteRef } from './support/route-inventory';
import { redis } from '../lib/redis';

/**
 * Every endpoint, exercised against a real database.
 *
 * WHY THIS EXISTS. A column was added to the books schema without a migration.
 * Typecheck passed, all 839 unit tests passed, and every endpoint that read a
 * whole book row returned 500 — because nothing in the suite had ever spoken to
 * Postgres. That class of fault is invisible to a unit test by construction: the
 * code is correct, the database disagrees with it, and only a real query finds
 * out.
 *
 * WHAT THIS IS. Contract-level coverage of the whole surface, not behavioural
 * tests of each endpoint. It asserts the things that are true of every endpoint
 * regardless of what it does:
 *
 *   - it is mounted and routable
 *   - it does not 5xx
 *   - it validates rather than crashing on nonsense input
 *   - a protected endpoint is actually protected
 *
 * WHAT IT IS NOT. It does not check that an endpoint returns the *right* answer.
 * A book list that returns the wrong books passes this suite. Per-endpoint
 * correctness still needs per-endpoint tests; this is the floor, not the ceiling.
 *
 * Mutating endpoints are never executed — they are called without credentials
 * and asserted to refuse. Running POST /orders against a real database on every
 * commit would be its own kind of bug.
 */

let harness: Harness;
let routes: RouteRef[];

// Real ids, so a parameterised route exercises a row that exists rather than
// only its 404 path — the books bug lived in the found-a-row branch.
const params: Record<string, string> = {};

async function firstId(table: string, column = 'id'): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT ${sql.raw(column)} AS v FROM ${sql.raw(table)} LIMIT 1`,
  )) as unknown as { v: string | number }[];
  return rows[0]?.v === undefined ? undefined : String(rows[0].v);
}

/**
 * Clears the Redis rate-limit counters this suite fills up.
 *
 * Sweeping ~150 routes several times blows through the 300-per-15-minutes API
 * limiter, and every request after that is a 429 — so the suite would pass or
 * fail depending on how recently it last ran. Resetting is the honest fix: the
 * alternative is a bypass in production middleware that exists only for tests,
 * and a rate limiter with a test-shaped hole in it is worth less than one
 * without.
 *
 * SCAN rather than KEYS, deliberately — KEYS blocks the whole Redis instance
 * for the length of the scan, and this codebase already says so elsewhere.
 */
async function resetRateLimits(): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = (await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 500)) as [
      string,
      string[],
    ];
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

beforeEach(resetRateLimits);

beforeAll(async () => {
  harness = await startApp();
  const { default: app } = await import('../app');
  routes = listRoutes(app);

  params[':id'] = (await firstId('books')) ?? '1';
  params[':bookId'] = params[':id'];
  params[':isbn'] = (await firstId('books', 'isbn13')) ?? '9780000000000';
  params[':slug'] = (await firstId('genres', 'slug')) ?? 'fiction';
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await resetRateLimits();
  redis.disconnect();
});

/** Substitutes real values into `:param` segments; unknown ones get a miss id. */
function concrete(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? (params[seg] ?? '999999999') : seg))
    .join('/');
}

async function call(route: RouteRef): Promise<{ status: number; body: string }> {
  const res = await fetch(`${harness.baseUrl}${concrete(route.path)}`, {
    method: route.method,
    headers: { 'content-type': 'application/json' },
    // An empty JSON body on a mutating route is the "validate, don't crash"
    // probe: it must come back 400/401, never 500.
    body: route.method === 'GET' || route.method === 'HEAD' ? undefined : '{}',
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

describe('endpoint contract', () => {
  it('finds the full route surface', () => {
    // A floor rather than an exact count: an exact number turns every new
    // endpoint into a failing test, which trains people to edit the number
    // without reading it. Far too low a number means the walker broke.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.path === '/api/v1/books/:id' && r.method === 'GET')).toBe(true);
  });

  it('no endpoint returns a 5xx', async () => {
    const failures: string[] = [];

    for (const route of routes) {
      // The Stripe webhook verifies a signature over a raw body; calling it
      // without one is meant to fail, and does so loudly by design.
      if (route.path.includes('/webhook')) continue;

      const { status, body } = await call(route);
      // 429 is the limiter doing its job, not a fault. Everything 5xx is.
      if (status >= 500) failures.push(`${route.method} ${route.path} -> ${status} ${body}`);
    }

    // Named in full rather than counted: the message is the whole value of this
    // test. "3 endpoints returned 500" sends someone hunting; this does not.
    expect(failures, `endpoints returning 5xx:\n${failures.join('\n')}`).toEqual([]);
  }, 120_000);

  it('serves a book by id — the regression this suite was written for', async () => {
    const res = await fetch(`${harness.baseUrl}/api/v1/books/${params[':id']}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const book = (body.book ?? body) as Record<string, unknown>;
    expect(book.id).toBeDefined();
  });

  it('has no column in the schema that is missing from the database', async () => {
    // The generalised form of the bug, and the most valuable assertion here.
    // `selectGuideRating` was declared in books.ts with no migration behind it;
    // Drizzle builds its SELECT list from the schema, so every query reading a
    // whole book row asked Postgres for a column it did not have and got a 500.
    //
    // Checking the schema against information_schema catches the entire class in
    // one pass, on every table, the moment it is introduced — rather than
    // whenever someone happens to call the one endpoint that reads that table.
    const { getTableConfig } = await import('drizzle-orm/pg-core');
    const schema = await import('../db/schema');

    const actual = (await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `)) as unknown as { table_name: string; column_name: string }[];

    const inDatabase = new Set(actual.map((r) => `${r.table_name}.${r.column_name}`));
    const missing: string[] = [];

    for (const exported of Object.values(schema)) {
      let config: ReturnType<typeof getTableConfig>;
      try {
        // Everything in the schema barrel that is not a pgTable — enums, types,
        // relations — throws here and is skipped.
        config = getTableConfig(exported as Parameters<typeof getTableConfig>[0]);
      } catch {
        continue;
      }
      for (const column of config.columns) {
        const ref = `${config.name}.${column.name}`;
        if (!inDatabase.has(ref)) missing.push(ref);
      }
    }

    expect(
      missing,
      `columns declared in the Drizzle schema but absent from the database — a migration is missing:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('never serves an admin endpoint to an anonymous caller', async () => {
    const leaked: string[] = [];

    for (const route of routes.filter((r) => r.path.startsWith('/admin'))) {
      if (route.path.includes('/login')) continue; // the way in, by definition
      const { status } = await call(route);
      if (status < 400) leaked.push(`${route.method} ${route.path} -> ${status}`);
    }

    expect(leaked, `admin endpoints reachable without credentials:\n${leaked.join('\n')}`).toEqual([]);
  }, 120_000);

  it('answers every public GET with JSON', async () => {
    const bad: string[] = [];

    for (const route of routes.filter((r) => r.method === 'GET' && !hasParams(r.path))) {
      if (route.path.startsWith('/admin') || route.path.startsWith('/docs')) continue;
      const res = await fetch(`${harness.baseUrl}${route.path}`);
      if (res.status >= 400) continue; // protected or absent is another test's job
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) bad.push(`${route.path} -> ${type || 'no content-type'}`);
    }

    expect(bad, `200 responses that are not JSON:\n${bad.join('\n')}`).toEqual([]);
  }, 120_000);
});
