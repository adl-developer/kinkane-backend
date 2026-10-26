import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';

/**
 * The Author Digital Labs staff account for the admin console.
 *
 * Seeded from setup.ts so it lands on every database `npm run db:init` runs
 * against — local, and prod through Render's preDeployCommand — rather than
 * relying on ADMIN_BOOTSTRAP_*, which only fires while the admins table is empty.
 *
 * The email and name live here; the password does not. A password committed to
 * the repo is a published one (see the ADMIN_BOOTSTRAP_* note in .env.example),
 * so it comes from ADMIN_SEED_PASSWORD, set per environment. Without it the seed
 * is skipped rather than failing the deploy.
 */
const ADMIN = { email: 'admin@authordigitallabs.com', name: 'Author Digital Labs' };

/** Same floor as scripts/create-admin.ts. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Inserts the admin if no account with that email exists yet.
 *
 * Insert-only on purpose: an existing row is left alone, so a re-run on every
 * deploy can never reset a password the admin has since changed, re-enable a
 * disabled account, or sign anyone out. Use `npm run admin:create` for those.
 *
 * Hashed with bcrypt cost 10, matching adminAuthService.hashPassword — imported
 * directly rather than through the service so setup.ts does not pull in the app
 * config and its drizzle pool.
 */
export async function seedAdmin(sql: Sql): Promise<'created' | 'exists' | 'skipped'> {
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) return 'skipped';
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_SEED_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await sql`
    INSERT INTO admins (name, email, password_hash)
    VALUES (${ADMIN.name}, ${ADMIN.email}, ${passwordHash})
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `;
  return inserted.length ? 'created' : 'exists';
}

export const SEEDED_ADMIN_EMAIL = ADMIN.email;
