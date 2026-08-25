/**
 * Seeds (or removes) demo data for the admin console.
 *
 *   npm run seed:demo            # create
 *   npm run seed:demo -- --reset # remove everything this script created
 *
 * For local QA and for whoever builds the console front end: the screens are
 * hard to judge against an empty database, and marking rows by hand in psql
 * gets you a half-state — a paid order with no notification, a report with no
 * reference — that does not look like anything production would produce.
 *
 * Everything goes through the real services, so references, notifications and
 * status transitions happen exactly as they do in life.
 *
 * **Never run this against production.** It refuses when NODE_ENV=production,
 * and every account it creates uses the reserved `.test` TLD (RFC 2606), which
 * cannot resolve — so a stray email can never reach a real person.
 */
import { and, eq, like } from 'drizzle-orm';
import { db } from '../src/db';
import {
  users, userReports, adminNotifications, orders, userSubscriptions, notificationPreferences,
} from '../src/db/schema';
import { reportsService } from '../src/services/reports.service';
import { adminNotificationsService } from '../src/services/admin/notifications.service';
import { formatMinor } from '../src/lib/money';
import { config } from '../src/config';

/** Every seeded account carries this, so cleanup is exact rather than a guess. */
const SEED_DOMAIN = '@seed.kinkane.test';

// Names and complaints lifted from the Figma moderation screen, so the seeded
// queue looks like the one the designs show.
const PEOPLE = [
  { name: 'Léa Moreau', email: 'lea.moreau' },
  { name: 'Yuki Tanaka', email: 'yuki.tanaka' },
  { name: 'Aisha Bello', email: 'aisha.bello' },
  { name: 'Kwame Asante', email: 'kwame.asante' },
  { name: 'Sofia Mensah', email: 'sofia.mensah' },
  { name: 'Priya Nair', email: 'priya.nair' },
];

async function reset(): Promise<void> {
  const seeded = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${SEED_DOMAIN}`));

  // Reports first — they reference the users. Subscriptions and preferences
  // cascade on user delete, so they need no separate pass.
  for (const u of seeded) {
    await db.delete(userReports).where(eq(userReports.reportedUserId, u.id));
    await db.delete(userReports).where(eq(userReports.reporterId, u.id));
  }
  await db.delete(users).where(like(users.email, `%${SEED_DOMAIN}`));
  await db.delete(adminNotifications);

  console.log(`Removed ${seeded.length} seeded accounts, their reports, and the notification feed.`);
  console.log('Orders were left alone — reset those by hand if you marked one paid.');
}

async function seed(): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%${SEED_DOMAIN}`));

  if (existing.length > 0) {
    console.log(`${existing.length} seeded accounts already exist. Run with --reset first.`);
    process.exit(1);
  }

  const made: Record<string, number> = {};
  for (const p of PEOPLE) {
    const [row] = await db
      .insert(users)
      .values({ name: p.name, email: p.email + SEED_DOMAIN, emailVerified: true })
      .returning({ id: users.id });

    // A user row alone is not an account. Signup also opens a subscription and
    // a notification-preferences row, and endpoints assume they exist —
    // GET /auth/me returns "Subscription not found" without one. Seeding just
    // the users table produces accounts that look fine in the console and
    // break the moment anyone signs in as them.
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db
      .insert(userSubscriptions)
      .values({ userId: row.id, tier: 'plus', status: 'trialing', trialEndsAt });
    await db.insert(notificationPreferences).values({ userId: row.id });

    made[p.email] = row.id;
  }
  console.log(`Created ${PEOPLE.length} accounts.`);

  // Four reports across three reported users. Deliberately shaped so each
  // console action can be tried without exhausting the queue, and so the
  // non-obvious behaviour — blacklisting closes EVERY pending report against
  // that person — is visible rather than something you have to take on trust.
  const filed = [
    {
      reporter: 'yuki.tanaka', reported: 'lea.moreau',
      reason: 'Sent offensive messages through the referral system after their discount code was declined.',
      note: 'dismiss this one',
    },
    {
      reporter: 'kwame.asante', reported: 'aisha.bello',
      reason: 'Created multiple accounts to abuse the 15% first-order discount. Confirmed duplicate email patterns.',
      note: 'blacklist this one',
    },
    {
      reporter: 'priya.nair', reported: 'sofia.mensah',
      reason: 'Left a misleading review claiming a book was out of print to discourage other buyers.',
      note: 'two reports, same person',
    },
    {
      reporter: 'yuki.tanaka', reported: 'sofia.mensah',
      reason: 'Repeatedly posting the same spam link under new releases.',
      note: 'blacklisting either closes both',
    },
  ];

  console.log('\nReports filed:');
  for (const f of filed) {
    const report = await reportsService.create(made[f.reporter], made[f.reported], f.reason);
    const ref = (report as { reference?: string }).reference;
    console.log(`  id=${String(report.id).padEnd(4)} ${ref}  ${f.reported.padEnd(14)} — ${f.note}`);
  }

  // An unread bell entry for an order, so the notification feed is not just
  // reports. Uses whichever order is already paid, if any.
  const [paid] = await db.select().from(orders).where(eq(orders.status, 'paid')).limit(1);
  if (paid) {
    await adminNotificationsService.emit({
      type: 'order_received',
      title: 'New order received',
      body: `${paid.reference} — ${formatMinor(paid.totalMinor, paid.presentmentCurrency)} from ${paid.contactEmail}.`,
      orderId: paid.id,
      userId: paid.userId ?? undefined,
    });
    console.log(`\nAdded an order notification for ${paid.reference}.`);
  }

  console.log('\nRun with --reset to remove all of it.');
}

async function main(): Promise<void> {
  if (config.env === 'production') {
    console.error('Refusing to run: NODE_ENV is production.');
    process.exit(1);
  }
  await (process.argv.includes('--reset') ? reset() : seed());
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', (err as Error).message);
  process.exit(1);
});
