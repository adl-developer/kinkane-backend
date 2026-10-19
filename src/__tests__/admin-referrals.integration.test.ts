import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * The admin console's referral analytics and Travellers list, against a real
 * Postgres.
 *
 * Nearly everything here is SQL — correlated subqueries, an array containment
 * scan, a distinct over a row tuple — so a unit test with a mocked db would
 * prove nothing. The fixture is one small tree with each awkward case in it: a
 * grandchild in another country (network reach), an unverified signup
 * (pending), a voided referral (must not count or make anyone a Traveller), a
 * Traveller with nothing yet, and a user who never took part.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users. Skips itself when unset; refuses to run when it names the same
 * database as `.env`. Setup as in nielsen-budget.integration.test.ts.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

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
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

// The analytics service imports the Redis client for its public cache. The
// admin path never reads it, and a test should not need Redis running.
vi.mock('../lib/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let service: typeof import('../services/admin/referrals.service').adminReferralsService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'admin-referrals-test-';

type Totals = Awaited<ReturnType<typeof service.analytics>>['totals'];

describeIfDb('admin referral analytics and Travellers', () => {
  const ids: Record<string, number> = {};
  let before: Totals;

  async function cleanUp(): Promise<void> {
    // Cascades through codes, clicks, invites, referrals and points.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function user(key: string, name: string, country: string | null): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email, country_code)
      VALUES (${name}, ${`${EMAIL_PREFIX}${key}@example.com`}, ${country})
      RETURNING id
    `);
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  async function code(userKey: string): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO referral_codes (user_id, code, slug)
      VALUES (${ids[userKey]}, ${`T${ids[userKey]}${Date.now() % 100000}`.slice(0, 32)}, ${userKey})
      RETURNING id
    `);
    return rows[0].id;
  }

  async function refer(
    referrer: string,
    referred: string,
    path: string[],
    country: string | null,
    opts: { credited?: boolean; voided?: boolean } = {},
  ): Promise<number> {
    const ancestorPath = `{${path.map((k) => ids[k]).join(',')}}`;
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO referrals (
        referrer_user_id, referred_user_id, depth, root_referrer_id, ancestor_path,
        redeemer_country, credited_at, status
      ) VALUES (
        ${ids[referrer]}, ${ids[referred]}, ${path.length}, ${ids[path[0]]}, ${ancestorPath}::integer[],
        ${country}, ${opts.credited ? sql`now()` : null}, ${opts.voided ? 'voided' : 'active'}
      )
      RETURNING id
    `);
    return rows[0].id;
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ adminReferralsService: service } = await import('../services/admin/referrals.service'));

    await cleanUp();
    before = (await service.analytics()).totals;

    // Ama (GH) → Bayo (NG, verified) → Claire (FR, verified)
    //          → Dede (GH, unverified)
    // Efua has a link and nothing else. Yaw arrived through Efua, but that
    // referral was voided. Xavier never took part.
    await user('ama', 'Ama Owusu', 'GH');
    await user('bayo', 'Bayo Adeyemi', 'NG');
    await user('claire', 'Claire Martin', 'FR');
    await user('dede', 'Dede Mensah', 'GH');
    await user('efua', 'Efua Boateng', 'GH');
    await user('yaw', 'Yaw Asante', 'GH');
    await user('xavier', 'Xavier Dupont', 'FR');

    const amaCode = await code('ama');
    await code('bayo');
    await code('efua');

    const amaToBayo = await refer('ama', 'bayo', ['ama'], 'NG', { credited: true });
    await refer('bayo', 'claire', ['ama', 'bayo'], 'FR', { credited: true });
    await refer('ama', 'dede', ['ama'], 'GH');
    await refer('efua', 'yaw', ['efua'], 'GH', { voided: true });

    await db.execute(sql`
      INSERT INTO referral_points (user_id, referral_id, kind, points, state) VALUES
        (${ids.ama}, ${amaToBayo}, 'same_continent', 10, 'counted'),
        (${ids.ama}, null, 'same_continent', 5, 'voided')
    `);

    await db.execute(sql`
      INSERT INTO referral_invites (user_id, channel) VALUES
        (${ids.ama}, 'whatsapp'), (${ids.ama}, 'copy'), (${ids.bayo}, 'sms')
    `);

    // Two people and one repeat tap, plus a link-preview bot: two clicks.
    await db.execute(sql`
      INSERT INTO referral_clicks (code_id, ip_hash, user_agent, is_bot) VALUES
        (${amaCode}, 'ip-1', 'ua', false),
        (${amaCode}, 'ip-1', 'ua', false),
        (${amaCode}, 'ip-2', 'ua', false),
        (${amaCode}, 'ip-3', 'WhatsApp/2', true)
    `);
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  async function all() {
    return service.travellers({ q: EMAIL_PREFIX, sort: 'points', limit: 100, offset: 0 });
  }

  it('lists everyone with a link or a live referral, and nobody else', async () => {
    const { travellers, total } = await all();
    const names = travellers.map((t) => t.name.split(' ')[0]).sort();

    // Yaw's only referral was voided; Xavier never took part.
    expect(names).toEqual(['Ama', 'Bayo', 'Claire', 'Dede', 'Efua']);
    expect(total).toBe(5);
  });

  it('gives each Traveller the same figures their own invite screen shows', async () => {
    const { travellers } = await all();
    const byName = Object.fromEntries(travellers.map((t) => [t.name.split(' ')[0], t]));

    expect(byName.Ama).toMatchObject({
      invitesSent: 2,
      clicks: 2,
      signups: 2,
      successful: 1,
      pending: 1,
      // NG and GH directly, FR through Bayo.
      countriesReached: 3,
      // The voided 5 does not count.
      points: 10,
      referredBy: null,
    });
    expect(byName.Bayo).toMatchObject({
      invitesSent: 1,
      signups: 1,
      successful: 1,
      countriesReached: 1,
      referredBy: { id: ids.ama, name: 'Ama Owusu' },
    });
    expect(byName.Efua).toMatchObject({ signups: 0, successful: 0, countriesReached: 0, points: 0 });
    expect(byName.Claire.referredBy).toEqual({ id: ids.bayo, name: 'Bayo Adeyemi' });
  });

  it('sorts by points by default and by verified signups on request', async () => {
    const { travellers } = await all();
    expect(travellers[0].id).toBe(ids.ama);

    const bySignups = await service.travellers({ q: EMAIL_PREFIX, sort: 'signups', limit: 2, offset: 0 });
    // Ama and Bayo each have one verified signup; Ama wins on total signups.
    expect(bySignups.travellers.map((t) => t.id)).toEqual([ids.ama, ids.bayo]);
  });

  it('pages through every Traveller exactly once', async () => {
    const seen: number[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const page = await service.travellers({ q: EMAIL_PREFIX, sort: 'points', limit: 2, offset });
      seen.push(...page.travellers.map((t) => t.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('searches by name', async () => {
    const { travellers } = await service.travellers({ q: 'Claire Martin', sort: 'points', limit: 20, offset: 0 });
    expect(travellers.map((t) => t.id)).toContain(ids.claire);
    expect(travellers.map((t) => t.id)).not.toContain(ids.ama);
  });

  it('adds the fixture to the campaign totals, and the weekly series sums to them', async () => {
    const { totals, weekly } = await service.analytics();

    expect(totals.travellers - before.travellers).toBe(5);
    expect(totals.sent - before.sent).toBe(3);
    // Voided referral excluded; Dede is a signup but not successful.
    expect(totals.signups - before.signups).toBe(3);
    expect(totals.successful - before.successful).toBe(2);
    expect(totals.countries).toBeGreaterThanOrEqual(3);

    // The cumulative chart ends where the total is.
    const last = weekly[weekly.length - 1];
    expect(last.cumulative).toBe(weekly.reduce((n, w) => n + w.converted, 0));
    expect(last.cumulative).toBe(totals.signups);
    expect(weekly.reduce((n, w) => n + w.sent, 0)).toBe(totals.sent);
  });
});
