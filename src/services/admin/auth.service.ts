import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { admins, type Admin } from '../../db/schema';
import { config } from '../../config';

export interface AdminSession {
  token: string;
  expiresIn: number;
  admin: { id: number; name: string; email: string };
}

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Refuses to work at all when `ADMIN_JWT_SECRET` is unset.
 *
 * The tempting fallback — reuse `JWT_ACCESS_SECRET` — would mean any customer
 * access token verifies against the admin console. An unconfigured console
 * nobody can log into is a deployment problem; one every customer can log into
 * is a breach.
 */
function adminSecret(): string {
  if (!config.jwt.adminSecret) {
    throw httpError('Admin console is not configured', 503, 'ADMIN_NOT_CONFIGURED');
  }
  return config.jwt.adminSecret;
}

// A well-formed bcrypt hash that nothing can match, compared against when no
// admin row was found so the two failure paths cost the same time.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export const adminAuthService = {
  async login(email: string, password: string): Promise<AdminSession> {
    const secret = adminSecret();

    const [admin] = await db
      .select()
      .from(admins)
      .where(and(eq(admins.email, email.toLowerCase()), isNull(admins.disabledAt)))
      .limit(1);

    // One message and one timing profile for "no such admin" and "wrong
    // password". This is a login form on the public internet, and telling an
    // attacker which staff addresses exist is free reconnaissance.
    const ok = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);
    if (!admin || !ok) {
      throw httpError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    await db.update(admins).set({ lastLoginAt: new Date() }).where(eq(admins.id, admin.id));

    const token = jwt.sign({ sub: admin.id, email: admin.email, kind: 'admin' }, secret, {
      expiresIn: config.jwt.adminTtl,
    });

    return {
      token,
      expiresIn: config.jwt.adminTtl,
      admin: { id: admin.id, name: admin.name, email: admin.email },
    };
  },

  /**
   * Verifies a console token and re-reads the account.
   *
   * The re-read is the point: disabling an admin then takes effect on their
   * next request rather than whenever their token happens to expire. One
   * indexed lookup per admin request, which at console traffic is nothing.
   */
  async verify(token: string): Promise<Admin> {
    const secret = adminSecret();

    let payload: { sub: number; kind?: string };
    try {
      payload = jwt.verify(token, secret) as unknown as { sub: number; kind?: string };
    } catch {
      throw httpError('Invalid or expired session', 401, 'INVALID_TOKEN');
    }

    // Belt and braces. The separate secret should already make a customer token
    // unusable here; this is what still stops one if the two were ever
    // misconfigured to match.
    if (payload.kind !== 'admin') {
      throw httpError('Invalid or expired session', 401, 'INVALID_TOKEN');
    }

    const [admin] = await db
      .select()
      .from(admins)
      .where(and(eq(admins.id, payload.sub), isNull(admins.disabledAt)))
      .limit(1);

    if (!admin) throw httpError('Invalid or expired session', 401, 'INVALID_TOKEN');
    return admin;
  },

  /**
   * Changes an admin's own password.
   *
   * Requires the current one. Not ceremony: an admin session lasts 12 hours, so
   * an unattended laptop is a plausible way in, and without this check that is
   * enough to lock the real owner out of an account that can suspend customers.
   *
   * Every other session for that admin is invalidated by consequence — the token
   * carries no password state, so this deliberately does *not* try to revoke
   * them. Say so rather than implying a logout that does not happen.
   */
  async changePassword(adminId: number, currentPassword: string, newPassword: string): Promise<void> {
    const [admin] = await db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
    if (!admin) throw httpError('Admin not found', 404);

    const ok = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!ok) throw httpError('Current password is incorrect', 401, 'INVALID_CREDENTIALS');

    // Refusing a no-op change: it means the person thinks they have rotated a
    // credential when they have not.
    if (currentPassword === newPassword) {
      throw httpError('The new password must be different', 400, 'PASSWORD_UNCHANGED');
    }

    await db
      .update(admins)
      .set({ passwordHash: await this.hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(admins.id, adminId));
  },

  /** Used by the create-admin script; hashing lives in one place. */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  },
};
