import crypto from 'crypto';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db';
import { users, refreshTokens, emailChangeRequests } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { enqueueEmail } from '../lib/email-queue';

const OTP_TTL_MS = 15 * 60 * 1000; // 15 minutes

function hashValue(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateOtp(): string {
  // Cryptographically random 6-digit code, zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export const emailChangeService = {
  /**
   * Initiates an email change request.
   * - Rejects if the new email is already taken.
   * - Overwrites any existing pending request for this user.
   * - Sends an OTP to the new email and a cancellation notice to the old email.
   */
  async requestEmailChange(userId: number, newEmail: string): Promise<void> {
    const normalizedEmail = newEmail.toLowerCase().trim();

    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if (user.email === normalizedEmail) {
      throw Object.assign(new Error('New email must be different from your current email'), {
        statusCode: 400,
      });
    }

    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (taken) {
      throw Object.assign(new Error('That email address is already in use'), { statusCode: 409 });
    }

    const otp = generateOtp();
    const rawCancelToken = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    // Atomic: delete any existing request then insert the new one in a single
    // transaction. The unique constraint on (user_id) in email_change_requests
    // is the authoritative race guard — if two concurrent requests slip through
    // the availability check above, the second insert will throw a unique
    // violation which we surface as a clean 409.
    try {
      await db.transaction(async (tx) => {
        await tx.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, userId));
        await tx.insert(emailChangeRequests).values({
          userId,
          newEmail: normalizedEmail,
          otpHash: hashValue(otp),
          cancelTokenHash: hashValue(rawCancelToken),
          expiresAt,
        });
      });
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      if (e.code === '23505') {
        throw Object.assign(new Error('That email address is already in use'), { statusCode: 409 });
      }
      throw err;
    }

    const cancelUrl = `${config.appUrl}/cancel-email-change?token=${rawCancelToken}`;

    // OTP goes to the new email so the user can verify they own it
    enqueueEmail('email-change-otp', { to: normalizedEmail, name: user.name, otp }).catch((err) => {
      logger.error('Failed to enqueue email-change OTP email', {
        userId,
        error: (err as Error).message,
      });
    });

    // Security notice + cancel link goes to the CURRENT (old) email so the
    // real owner can cancel if they didn't initiate this change
    enqueueEmail('email-change-notify', {
      to: user.email,
      name: user.name,
      cancelUrl,
    }).catch((err) => {
      logger.error('Failed to enqueue email-change notify email', {
        userId,
        error: (err as Error).message,
      });
    });
  },

  /**
   * Verifies the OTP and commits the email change.
   * On success: updates the user's email, invalidates all refresh tokens,
   * and deletes the pending request.
   */
  async verifyEmailChange(userId: number, otp: string): Promise<void> {
    const [pending] = await db
      .select()
      .from(emailChangeRequests)
      .where(
        and(
          eq(emailChangeRequests.userId, userId),
          gt(emailChangeRequests.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!pending) {
      throw Object.assign(
        new Error('No pending email change request found, or it has expired'),
        { statusCode: 400 },
      );
    }

    if (pending.otpHash !== hashValue(otp.trim())) {
      throw Object.assign(new Error('Invalid verification code'), { statusCode: 400 });
    }

    // Check the target email is still available (race condition guard)
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, pending.newEmail))
      .limit(1);

    if (taken) {
      await db.delete(emailChangeRequests).where(eq(emailChangeRequests.id, pending.id));
      throw Object.assign(new Error('That email address is no longer available'), {
        statusCode: 409,
      });
    }

    // Atomic: update email, delete pending request, invalidate all sessions
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ email: pending.newEmail, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx
        .delete(emailChangeRequests)
        .where(eq(emailChangeRequests.id, pending.id));
      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
    });
  },

  /**
   * Cancels a pending email change via the token sent to the old email.
   * Intentionally does not require authentication — the old email owner
   * may no longer have access to the account if it was compromised.
   */
  async cancelEmailChange(rawCancelToken: string): Promise<void> {
    const tokenHash = hashValue(rawCancelToken);

    const [pending] = await db
      .select({ id: emailChangeRequests.id })
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.cancelTokenHash, tokenHash))
      .limit(1);

    if (!pending) {
      throw Object.assign(new Error('Invalid or expired cancellation link'), { statusCode: 400 });
    }

    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.id, pending.id));
  },

  /**
   * Resends the OTP to the pending new email address.
   * Generates a fresh OTP and cancel token, resets the expiry.
   */
  async resendOtp(userId: number): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const [pending] = await db
      .select()
      .from(emailChangeRequests)
      .where(
        and(
          eq(emailChangeRequests.userId, userId),
          gt(emailChangeRequests.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!pending) {
      throw Object.assign(
        new Error('No active email change request found, or it has expired'),
        { statusCode: 400 },
      );
    }

    const otp = generateOtp();
    const rawCancelToken = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await db
      .update(emailChangeRequests)
      .set({
        otpHash: hashValue(otp),
        cancelTokenHash: hashValue(rawCancelToken),
        expiresAt,
      })
      .where(eq(emailChangeRequests.id, pending.id));

    const cancelUrl = `${config.appUrl}/cancel-email-change?token=${rawCancelToken}`;

    enqueueEmail('email-change-otp', { to: pending.newEmail, name: user.name, otp }).catch((err) => {
      logger.error('Failed to enqueue resend OTP email', {
        userId,
        error: (err as Error).message,
      });
    });

    // Security notice + fresh cancel link goes to the CURRENT (old) email
    enqueueEmail('email-change-notify', {
      to: user.email,
      name: user.name,
      cancelUrl,
    }).catch((err) => {
      logger.error('Failed to enqueue resend notify email', {
        userId,
        error: (err as Error).message,
      });
    });
  },
};
