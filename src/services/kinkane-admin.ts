import { sql } from 'drizzle-orm';
import type { db } from '../db';
import { users } from '../db/schema';

/** Either the pool or an open transaction. */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The house account's address — also the address moderation appeals go to. */
export const KINKANE_ADMIN_EMAIL = 'contactus@kinkane.app';
export const KINKANE_ADMIN_NAME = 'Kinkané Admin';

/**
 * The house account that takes over groups whose owner is blacklisted, so a
 * club does not lose its owner along with them. Created the first time it is
 * needed rather than seeded, so it exists wherever a blacklist can happen; if
 * someone has already signed up with the address, that account is the one
 * used. It has no password, so nobody signs in to it with one.
 */
export async function ensureKinkaneAdmin(handle: DbHandle): Promise<number> {
  const [row] = await handle
    .insert(users)
    .values({ name: KINKANE_ADMIN_NAME, email: KINKANE_ADMIN_EMAIL, emailVerified: true, shelfVisibility: 'private' })
    // A no-op update, so the existing row's id comes back too.
    .onConflictDoUpdate({ target: users.email, set: { email: sql`excluded.email` } })
    .returning({ id: users.id });
  return row.id;
}
