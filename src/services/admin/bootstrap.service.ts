import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { admins } from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { adminAuthService } from './auth.service';

/**
 * Creates the very first admin from the environment, for a deployment with no
 * shell to run `npm run admin:create` in.
 *
 * **Only ever fires while the admins table is empty.** That is the whole safety
 * property: it cannot reset a live account, cannot resurrect a deleted one, and
 * cannot be used to quietly re-take a console someone has already secured. Once
 * one admin exists this is inert, whatever the environment says.
 *
 * Deliberately *not* a hardcoded default credential. A password committed to the
 * repo is published — in the git history, in every clone, and guessable from the
 * product name — on an account that can suspend customers and export the whole
 * customer list. Defaults also outlive the intention to change them, and nothing
 * tells you whether one still stands. This takes the credential from the
 * environment, where the other secrets already are, and the operator picks it.
 *
 * Never throws: a server that will not boot because it could not create an
 * optional account is worse than one with no admin yet.
 */
export async function bootstrapFirstAdmin(): Promise<void> {
  const email = config.jwt.adminBootstrapEmail;
  const password = config.jwt.adminBootstrapPassword;

  if (!email || !password) return;

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(admins);

    if (count > 0) {
      logger.info('ADMIN_BOOTSTRAP_* is set but admins already exist — ignoring', {
        adminCount: count,
        hint: 'Remove ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD.',
      });
      return;
    }

    const passwordHash = await adminAuthService.hashPassword(password);
    const [created] = await db
      .insert(admins)
      .values({ email: email.toLowerCase(), name: 'Administrator', passwordHash })
      .returning({ id: admins.id });

    // The email is logged; the password is not, and must not be.
    logger.warn('Created the first admin from ADMIN_BOOTSTRAP_*', {
      adminId: created.id,
      email: email.toLowerCase(),
      next: 'Sign in, change the password, then remove both bootstrap variables.',
    });
  } catch (err) {
    logger.error('Could not bootstrap the first admin', { error: (err as Error).message });
  }
}
