import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, gt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { users, refreshTokens, userProviders, guestSessions, userPreferences, userInteractions, userBooks, userSubscriptions, passwordResetTokens, emailVerificationTokens, books, bookContributors, notificationPreferences } from '../db/schema';
import { getEffectiveTier } from '../db/schema/subscriptions';
import { config } from '../config';
import { admin } from '../lib/firebase';
import { logger } from '../lib/logger';
import { enqueueEmail } from '../lib/email-queue';
import { generateEmbedding } from '../lib/gemini';
import { buildPreferenceText } from './recommendations.service';

const BCRYPT_ROUNDS = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  emailVerified: boolean;
}

export interface MeUser extends AuthUser {
  photoUrl: string | null;
  subscription: {
    tier: 'free' | 'plus';
    status: 'active' | 'trialing' | 'cancelled';
    effectiveTier: 'free' | 'plus';
    trialEndsAt: Date | null;
  };
  providers: string[];
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

export function signAccessToken(userId: number, email: string): string {
  return jwt.sign({ sub: userId, email }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  });
}

async function issueTokenPair(userId: number, email: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId, email);

  const rawRefresh = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtl * 1000);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(rawRefresh),
    expiresAt,
  });

  return { accessToken, refreshToken: rawRefresh };
}

// ── Guest session migration ───────────────────────────────────────────────────

async function generatePreferenceEmbedding(
  userId: number,
  session: { feelings: string[]; bookIds: number[]; genres: string[]; dislikes: import('../db/schema/onboarding').Dislikes },
): Promise<void> {
  const likedBooks: { id: number; title: string; authors: string[] }[] = [];

  if (session.bookIds.length > 0) {
    const bookRows = await db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(inArray(books.id, session.bookIds));

    const contributorRows = await db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(and(inArray(bookContributors.bookId, session.bookIds), eq(bookContributors.role, 'A01')))
      .orderBy(bookContributors.sequenceNumber);

    const authorMap = new Map<number, string[]>();
    for (const c of contributorRows) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    for (const b of bookRows) {
      likedBooks.push({ id: b.id, title: b.title, authors: authorMap.get(b.id) ?? [] });
    }
  }

  const text = buildPreferenceText(
    { feelings: session.feelings, genres: session.genres, dislikes: session.dislikes },
    likedBooks,
  );

  const embedding = await generateEmbedding(text);

  await db
    .update(userPreferences)
    .set({ preferenceEmbedding: embedding })
    .where(eq(userPreferences.userId, userId));
}

/**
 * Copies onboarding data from a guest session to the newly created user record.
 * Runs after the user row already exists. Non-transactional by design —
 * if any step fails the user account is still fully usable; the error is logged.
 *
 * Steps:
 *  1. Save structured preferences (feelings, genres, dislikes, liked books)
 *  2. Seed reading list with the 5 chosen books (status: want_to_read)
 *  3. Record those choices as interactions (type: chosen_from_recommendation)
 *  4. Delete the guest session row
 */
async function migrateGuestSession(userId: number, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete-first strategy: deleting the row is the atomic lock.
    // If two concurrent registrations race, only one DELETE returns a row;
    // the other gets an empty array and exits cleanly — no duplicate inserts possible.
    const deleted = await tx
      .delete(guestSessions)
      .where(
        and(
          eq(guestSessions.id, sessionId),
          gt(guestSessions.expiresAt, new Date()),
        ),
      )
      .returning();

    if (deleted.length === 0) {
      logger.warn('Guest session not found or expired during migration — skipping', {
        sessionId,
        userId,
      });
      return;
    }

    const session = deleted[0];

    // 1. User preferences
    await tx.insert(userPreferences).values({
      userId,
      feelings: session.feelings,
      bookIds: session.bookIds,
      genres: session.genres,
      dislikes: session.dislikes,
    });

    // Generate and store the preference embedding outside the transaction
    // (Gemini call — non-blocking, failure is logged but does not affect signup).
    generatePreferenceEmbedding(userId, session).catch((err) => {
      logger.error('Failed to generate preference embedding after migration', {
        userId,
        error: (err as Error).message,
      });
    });

    // Copy reader type inferred during onboarding selections
    if (session.readerType) {
      await tx.update(users).set({ readerType: session.readerType }).where(eq(users.id, userId));
    }

    // 2 + 3. Seed reading list and interaction signals for each chosen book
    if ((session.chosenBookIds ?? []).length > 0) {
      await tx
        .insert(userBooks)
        .values(
          (session.chosenBookIds ?? []).map((bookId) => ({
            userId,
            bookId,
            status: null,
            source: 'chosen_from_onboarding',
            liked: true,
            likedAt: new Date(),
          })),
        )
        .onConflictDoNothing();

      await tx.insert(userInteractions).values(
        (session.chosenBookIds ?? []).map((bookId) => ({
          userId,
          bookId,
          type: 'chosen_from_recommendation',
          weight: 1.0,
        })),
      );
    }

    logger.info('Guest session migrated successfully', { sessionId, userId });
  });
}

// ── Subscription ──────────────────────────────────────────────────────────────

const TRIAL_DAYS = 90; // 3 months

// ── Email verification ──────────────────────────────────────────────────────────

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Issues a fresh email-verification token for the user (replacing any
 * existing one) and enqueues the verification email. Errors enqueuing the
 * email are logged but not thrown — same fire-and-forget pattern as the
 * other post-signup side effects.
 */
async function issueEmailVerification(userId: number, email: string, name: string): Promise<void> {
  await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));

  const rawToken = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });

  const verificationUrl = `${config.appUrl}/verify-email?token=${rawToken}`;

  enqueueEmail('verify-email', { to: email, name, verificationUrl }).catch((err) => {
    logger.error('Failed to enqueue verification email', {
      userId,
      error: (err as Error).message,
    });
  });
}

// ── Auth service ──────────────────────────────────────────────────────────────

export const authService = {
  async signup(
    name: string,
    email: string,
    password: string,
    guestSessionId: string,
  ): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      throw Object.assign(new Error('An account with this email already exists'), {
        statusCode: 409,
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    // Atomic: user + subscription committed together — if either insert fails,
    // neither row persists and the client can safely retry without hitting a 409.
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ name: name.trim(), email: email.toLowerCase().trim(), passwordHash })
        .returning({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified });
      await tx.insert(userSubscriptions).values({ userId: u.id, tier: 'plus', status: 'trialing', trialEndsAt });
      await tx.insert(notificationPreferences).values({ userId: u.id });
      return u;
    });

    const tokens = await issueTokenPair(user.id, user.email);

    migrateGuestSession(user.id, guestSessionId).catch((err) => {
      logger.error('Guest session migration failed after signup', {
        guestSessionId,
        userId: user.id,
        error: (err as Error).message,
      });
    });

    enqueueEmail('welcome', { to: user.email, name: user.name }).catch((err) => {
      logger.error('Failed to enqueue welcome email after signup', {
        userId: user.id,
        error: (err as Error).message,
      });
    });

    issueEmailVerification(user.id, user.email, user.name).catch((err) => {
      logger.error('Failed to issue email verification after signup', {
        userId: user.id,
        error: (err as Error).message,
      });
    });

    return { user, tokens };
  },

  async login(
    email: string,
    password: string,
  ): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);

    // Perform a dummy hash comparison even when user not found to prevent
    // timing attacks that would reveal whether an email exists
    const hash = user?.passwordHash ?? '$2a$12$invalidhashfortimingprotection000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
    }

    const tokens = await issueTokenPair(user.id, user.email);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      },
      tokens,
    };
  },

  async refresh(rawToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(rawToken);

    // Atomically consume the token: DELETE returns the row only if it exists and
    // hasn't expired. Two concurrent requests with the same token race on this
    // DELETE — only one wins and receives the userId; the other gets an empty array
    // and falls through to the 401, preventing double-issuance.
    const [consumed] = await db
      .delete(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: refreshTokens.userId });

    if (!consumed) {
      throw Object.assign(new Error('Invalid or expired refresh token'), { statusCode: 401 });
    }

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, consumed.userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 401 });
    }

    return issueTokenPair(user.id, user.email);
  },

  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
  },

  /**
   * Initiates a password reset for the given email address.
   * Always resolves silently — never reveals whether the email is registered,
   * to prevent account enumeration.
   */
  async forgotPassword(email: string): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);

    // Return without error even if no account exists — caller gets the same 200
    if (!user) return;

    // One active token per user — delete any existing ones before issuing a new one
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));

    const rawToken = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt,
    });

    const resetUrl = `${config.appUrl}/reset-password?token=${rawToken}`;

    enqueueEmail('password-reset', { to: user.email, name: user.name, resetUrl }).catch((err) => {
      logger.error('Failed to enqueue password reset email', {
        userId: user.id,
        error: (err as Error).message,
      });
    });
  },

  /**
   * Validates the reset token and updates the user's password.
   * Deletes the token and all active refresh tokens on success,
   * forcing the user to log in again on all devices.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);

    const [stored] = await db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    if (!stored || stored.expiresAt < new Date()) {
      throw Object.assign(new Error('Invalid or expired password reset token'), { statusCode: 400 });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Atomic: update password, consume token, invalidate all sessions
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, stored.userId));
      await tx
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.id, stored.id));
      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, stored.userId));
    });
  },

  /**
   * Validates the email-verification token and marks the user's email as verified.
   * The token is single-use — deleted on success.
   */
  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);

    const [stored] = await db
      .select({
        id: emailVerificationTokens.id,
        userId: emailVerificationTokens.userId,
        expiresAt: emailVerificationTokens.expiresAt,
      })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, tokenHash))
      .limit(1);

    if (!stored || stored.expiresAt < new Date()) {
      throw Object.assign(new Error('Invalid or expired verification link'), { statusCode: 400 });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, stored.userId));
      await tx
        .delete(emailVerificationTokens)
        .where(eq(emailVerificationTokens.id, stored.id));
    });
  },

  /**
   * Resends the verification email for the authenticated user. No-op (but
   * still 200) if the email is already verified — issues a fresh token and
   * resets the 24-hour expiry otherwise.
   */
  async resendVerificationEmail(userId: number): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if (user.emailVerified) {
      return;
    }

    await issueEmailVerification(user.id, user.email, user.name);
  },

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if (!user.passwordHash) {
      throw Object.assign(
        new Error('This account uses social login and has no password to change'),
        { statusCode: 400 },
      );
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      throw Object.assign(new Error('Current password is incorrect'), { statusCode: 401 });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Atomic: update password and revoke all active sessions so other devices
    // (including any attacker holding a stolen token) are forced to re-authenticate.
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, userId));
    });

    enqueueEmail('password-changed', { to: user.email, name: user.name }).catch((err) => {
      logger.error('Failed to enqueue password-changed email', {
        userId,
        error: (err as Error).message,
      });
    });
  },

  async deleteAccount(userId: number, password: string): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if (!user.passwordHash) {
      throw Object.assign(
        new Error('This account uses social login and has no password'),
        { statusCode: 400 },
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw Object.assign(new Error('Incorrect password'), { statusCode: 401 });
    }

    // Explicitly revoke tokens before deleting the user row so there is no
    // window where a valid token exists for a non-existent account (regardless
    // of whether the FK has ON DELETE CASCADE configured).
    await db.transaction(async (tx) => {
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });

    enqueueEmail('account-deleted', { to: user.email, name: user.name }).catch((err) => {
      logger.error('Failed to enqueue account-deleted email', {
        userId,
        error: (err as Error).message,
      });
    });
  },

  async getMe(userId: number): Promise<MeUser> {
    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        photoUrl: users.photoUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .limit(1);

    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    const providerRows = await db
      .select({ provider: userProviders.provider })
      .from(userProviders)
      .where(eq(userProviders.userId, userId));

    return {
      ...user,
      subscription: {
        tier: sub.tier,
        status: sub.status,
        effectiveTier: getEffectiveTier(sub),
        trialEndsAt: sub.trialEndsAt,
      },
      providers: providerRows.map((r) => r.provider),
    };
  },

  verifyAccessToken(token: string): { sub: number; email: string } {
    try {
      const payload = jwt.verify(token, config.jwt.accessSecret) as unknown as {
        sub: number;
        email: string;
      };
      return payload;
    } catch {
      throw Object.assign(new Error('Invalid or expired access token'), { statusCode: 401 });
    }
  },

  async socialLogin(
    idToken: string,
    guestSessionId: string | undefined,
  ): Promise<{ user: AuthUser; tokens: TokenPair; isNewUser: boolean }> {
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      throw Object.assign(new Error('Invalid Firebase ID token'), { statusCode: 401 });
    }

    const provider = decoded.firebase.sign_in_provider;
    const providerUid = decoded.uid;
    const email = decoded.email?.toLowerCase().trim();
    const name = decoded.name ?? '';
    const photoUrl = decoded.picture ?? null;

    if (!email) {
      throw Object.assign(new Error('Social account has no email address'), { statusCode: 422 });
    }

    // 1. Check if this exact provider account already exists
    const [existingProvider] = await db
      .select({ userId: userProviders.userId })
      .from(userProviders)
      .where(and(eq(userProviders.provider, provider), eq(userProviders.providerUid, providerUid)))
      .limit(1);

    if (existingProvider) {
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, existingProvider.userId))
        .limit(1);

      const tokens = await issueTokenPair(user.id, user.email);
      return { user, tokens, isNewUser: false };
    }

    // 2. Check if a user with the same email already exists (account linking)
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser) {
      await db.insert(userProviders).values({ userId: existingUser.id, provider, providerUid });

      // Backfill photo if missing
      if (!existingUser.photoUrl && photoUrl) {
        await db.update(users).set({ photoUrl }).where(eq(users.id, existingUser.id));
      }

      const tokens = await issueTokenPair(existingUser.id, existingUser.email);
      return {
        user: { id: existingUser.id, name: existingUser.name, email: existingUser.email, emailVerified: true },
        tokens,
        isNewUser: false,
      };
    }

    // 3. Brand new user — guestSessionId is required to migrate onboarding data
    if (!guestSessionId) {
      throw Object.assign(
        new Error('guestSessionId is required when creating a new account via social login'),
        { statusCode: 400 },
      );
    }

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    // Atomic: user + provider link + subscription committed together.
    const newUser = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ name, email, photoUrl, emailVerified: true })
        .returning({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified });
      await tx.insert(userProviders).values({ userId: u.id, provider, providerUid });
      await tx.insert(userSubscriptions).values({ userId: u.id, tier: 'plus', status: 'trialing', trialEndsAt });
      await tx.insert(notificationPreferences).values({ userId: u.id });
      return u;
    });

    const tokens = await issueTokenPair(newUser.id, newUser.email);

    migrateGuestSession(newUser.id, guestSessionId).catch((err) => {
      logger.error('Guest session migration failed after social login', {
        guestSessionId,
        userId: newUser.id,
        error: (err as Error).message,
      });
    });

    enqueueEmail('welcome', { to: newUser.email, name: newUser.name }).catch((err) => {
      logger.error('Failed to enqueue welcome email after social signup', {
        userId: newUser.id,
        error: (err as Error).message,
      });
    });

    return { user: newUser, tokens, isNewUser: true };
  },
};
