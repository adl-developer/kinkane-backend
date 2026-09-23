import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * The Nielsen daily budget, against a real Postgres.
 *
 * WHY THIS EXISTS. The whole design rests on one claim: that a single guarded
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` hands out at most
 * N records per day however many callers ask at once. That is a property of
 * Postgres's concurrency behaviour, not of our TypeScript — a unit test with a
 * mocked database would assert only that we wrote the SQL we wrote. If the
 * guard is wrong, the failure is silent (we quietly overspend a metered
 * account) and only shows up as Nielsen cutting us off mid-day.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL. These tests truncate
 * a table, and this project's `.env` points at production. The suite skips
 * itself when TEST_DATABASE_URL is unset and refuses to run when it names the
 * same database as `.env`.
 *
 * SETUP. Point TEST_DATABASE_URL at a scratch database with migrations
 * applied:
 *
 *   createdb kinkane_test
 *   DATABASE_URL=postgres://localhost:5432/kinkane_test npm run db:migrate
 *   TEST_DATABASE_URL=postgres://localhost:5432/kinkane_test npm run test:integration
 */

const testUrl = process.env.TEST_DATABASE_URL;

/** The database `.env` points at — the one these tests must never write to. */
function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

/** Host + database name only: enough to tell two targets apart, no credentials. */
function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests truncate tables — point them at a scratch database.',
    );
  }
  // Must happen before any import that reaches config/db. dotenv does not
  // overwrite a variable that is already set, so this wins over `.env`.
  process.env.DATABASE_URL = testUrl;
}

// Imported lazily so the assignment above lands first.
type Claim = (kind: 'batch' | 'onDemand') => Promise<boolean>;
let claimBudget: Claim;
let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;

const describeIfDb = testUrl ? describe : describe.skip;

describeIfDb('Nielsen daily budget claim', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ claimBudget } = await import('../services/book-reviews.service'));

    const [present] = (await db.execute(sql`SELECT to_regclass('public.nielsen_api_usage') AS t`)) as unknown as {
      t: string | null;
    }[];

    if (!present?.t) {
      throw new Error(
        'nielsen_api_usage does not exist in TEST_DATABASE_URL. Run `npm run db:migrate` against it first.',
      );
    }
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE nielsen_api_usage`);
  });

  afterAll(async () => {
    if (!testUrl) return;
    await db.execute(sql`TRUNCATE nielsen_api_usage`);
  });

  async function setUsage(fields: {
    batchUsed?: number;
    onDemandUsed?: number;
    limitHit?: boolean;
  }): Promise<void> {
    await db.execute(sql`
      INSERT INTO nielsen_api_usage (day, batch_used, on_demand_used, limit_hit_at)
      VALUES (
        CURRENT_DATE,
        ${fields.batchUsed ?? 0},
        ${fields.onDemandUsed ?? 0},
        ${fields.limitHit ? sql`now()` : sql`NULL`}
      )
    `);
  }

  async function usage(): Promise<{ batch: number; onDemand: number }> {
    const rows = (await db.execute(
      sql`SELECT batch_used, on_demand_used FROM nielsen_api_usage WHERE day = CURRENT_DATE`,
    )) as unknown as { batch_used: number | string; on_demand_used: number | string }[];

    if (rows.length === 0) return { batch: 0, onDemand: 0 };
    return { batch: Number(rows[0].batch_used), onDemand: Number(rows[0].on_demand_used) };
  }

  it('creates the day row on the first claim', async () => {
    expect(await claimBudget('onDemand')).toBe(true);
    expect(await usage()).toEqual({ batch: 0, onDemand: 1 });
  });

  it('grants exactly the configured allowance and refuses the next one', async () => {
    // The default on-demand budget is 100, so start 2 short of it rather than
    // issuing a hundred round trips to prove the boundary.
    await setUsage({ onDemandUsed: 98 });

    expect(await claimBudget('onDemand')).toBe(true);
    expect(await claimBudget('onDemand')).toBe(true);
    expect(await claimBudget('onDemand')).toBe(false);

    // The refused claim must not have incremented anything.
    expect((await usage()).onDemand).toBe(100);
  });

  it('hands out the last records to one caller each under concurrency', async () => {
    // THE test. Forty callers race for five remaining records; exactly five
    // may win. A read-then-write implementation passes every other test here
    // and fails this one.
    await setUsage({ onDemandUsed: 95 });

    const results = await Promise.all(Array.from({ length: 40 }, () => claimBudget('onDemand')));
    const granted = results.filter(Boolean).length;

    expect(granted).toBe(5);
    // The counter and the number of winners have to agree: a counter that ran
    // past 100 would mean records were spent without a caller being told it
    // had one, which is the overspend this guard exists to prevent.
    expect((await usage()).onDemand).toBe(100);
  });

  it('keeps the batch and on-demand allowances separate', async () => {
    // A spent nightly batch must not deny a visitor their lookup — that split
    // is the entire reason the two are counted in different columns.
    await setUsage({ batchUsed: 900, onDemandUsed: 0 });

    expect(await claimBudget('batch')).toBe(false);
    expect(await claimBudget('onDemand')).toBe(true);

    expect(await usage()).toEqual({ batch: 900, onDemand: 1 });
  });

  it('stops both halves once Nielsen itself reports the limit', async () => {
    // Our counters are an estimate; resultCode 50 is the authority. With the
    // flag set, claims must be refused even though both budgets look unspent.
    await setUsage({ batchUsed: 0, onDemandUsed: 0, limitHit: true });

    expect(await claimBudget('batch')).toBe(false);
    expect(await claimBudget('onDemand')).toBe(false);

    expect(await usage()).toEqual({ batch: 0, onDemand: 0 });
  });

  it('counts yesterday separately from today', async () => {
    // Usage is keyed by date, so a row left over from yesterday must not eat
    // into today's allowance.
    await db.execute(sql`
      INSERT INTO nielsen_api_usage (day, batch_used, on_demand_used)
      VALUES (CURRENT_DATE - 1, 900, 100)
    `);

    expect(await claimBudget('onDemand')).toBe(true);
    expect((await usage()).onDemand).toBe(1);
  });
});
