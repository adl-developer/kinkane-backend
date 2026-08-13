import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, gt, inArray } from 'drizzle-orm';
import { db } from '../db';
import { users, refreshTokens, userProviders, guestSessions, userPreferences, userInteractions, userBooks, userSubscriptions, subscriptionEvents, passwordResetTokens, emailVerificationTokens, books, bookContributors, notificationPreferences } from '../db/schema';
import { config } from '../config';
import { admin } from '../lib/firebase';
import { logger } from '../lib/logger';
import { enqueueEmail } from '../lib/email-queue';
import { generateEmbedding } from '../lib/gemini';
import { buildPreferenceText } from './recommendations.service';
import { preferenceHistoryService } from './preference-history.service';
import { dislikedBooksService } from './disliked-books.service';
import { subscriptionStateService } from './subscriptions/state.service';
import { checkoutService } from './subscriptions/checkout.service';
import { referralsService } from './referrals.service';
import { referralScoringService } from './referral-scoring.service';
import type { CountrySource } from './geo.service';
import type { SubscriptionTier, SubscriptionStatus, SubscriptionPlan } from '../db/schema';

const BCRYPT_ROUNDS = 12;

/**
 * How old a Firebase ID token's `auth_time` may be and still count as "fresh"
 * proof of ownership for a sensitive action. Set generously — the client has
 * to prompt a re-auth, wait for the OS provider sheet, and post — but well
 * inside a Firebase ID token's own 1-hour validity so a cached token can't
 * stand in for a real just-now sign-in.
 */
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

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
  joinedYear: number;
  subscription: {
    tier: SubscriptionTier;
    // Sourced from the enum rather than restated, so adding a Stripe-driven
    // status (past_due, incomplete) can't leave this contract behind.
    status: SubscriptionStatus;
    // Which recurring interval was bought — null while free or trialing.
    plan: SubscriptionPlan | null;
    trialDaysLeft: number | null;
    trialEndsAt: Date | null;
    // End of the paid period Stripe has already collected for. Read together
    // with cancelAtPeriodEnd: it's a renewal date unless that flag is set, in
    // which case it's the date access actually ends.
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
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
 *  0. Promote books swiped away during onboarding into the user's permanent
 *     rejection history (user_disliked_books)
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
    const dislikedBookIds = session.dislikedBookIds ?? [];

    // 0. Books swiped away during onboarding become the user's permanent
    // rejection history. Written before the history snapshot below so that
    // snapshot records the set the user actually finished onboarding with.
    if (dislikedBookIds.length > 0) {
      await dislikedBooksService.record(userId, dislikedBookIds, 'onboarding_selection', { tx });
    }

    // 1. User preferences
    await tx.insert(userPreferences).values({
      userId,
      feelings: session.feelings,
      bookIds: session.bookIds,
      genres: session.genres,
      dislikes: session.dislikes,
    });

    // Baseline entry in the preference audit log. Runs inside the transaction
    // so it rolls back with the rest if migration fails. Reader type is passed
    // explicitly because the users row isn't updated until a few lines below.
    await preferenceHistoryService.record(
      userId,
      {
        feelings: session.feelings,
        bookIds: session.bookIds,
        genres: session.genres,
        dislikes: session.dislikes,
        dislikedBookIds,
      },
      'onboarding',
      { readerType: session.readerType ?? null, tx },
    );

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

      await tx
        .insert(userInteractions)
        .values(
          (session.chosenBookIds ?? []).map((bookId) => ({
            userId,
            bookId,
            type: 'chosen_from_recommendation',
            weight: 1.0,
          })),
        )
        // A repeated book ID in chosenBookIds would now violate the partial unique
        // index on (user_id, book_id, type) and abort the whole migration transaction.
        .onConflictDoNothing();
    }

    logger.info('Guest session migrated successfully', { sessionId, userId });
  });
}

// ── Subscription ──────────────────────────────────────────────────────────────

const TRIAL_DAYS = 90; // 3 months

// ── Email verification ──────────────────────────────────────────────────────────

const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function generateOtp(): string {
  // Cryptographically random 6-digit code, zero-padded
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issues a fresh email-verification token for the user (replacing any
 * existing one) and enqueues the verification email. Errors enqueuing the
 * email are logged but not thrown — same fire-and-forget pattern as the
 * other post-signup side effects.
 */
async function issueEmailVerification(userId: number, email: string, name: string): Promise<void> {
  await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await db.insert(emailVerificationTokens).values({
    userId,
    otpHash: hashToken(otp),
    expiresAt,
  });

  enqueueEmail('verify-email', {
    to: email,
    name,
    otp,
    expiryMinutes: EMAIL_VERIFICATION_TTL_MS / 60_000,
  }).catch((err) => {
    logger.error('Failed to enqueue verification email', {
      userId,
      error: (err as Error).message,
    });
  });
}

// ── Referral attribution ──────────────────────────────────────────────────────

/**
 * Everything a new account needs to be placed in the referral competition:
 * which code brought them (if any), and where they are.
 *
 * Optional throughout — signup predates all of this, and an account must still
 * be creatable when no code was used, when geolocation is unconfigured, or when
 * the lookup simply failed.
 */
export interface SignupContext {
  referralCode?: string;
  country?: { code: string | null; source: CountrySource };
  channel?: string;
  clickId?: number | null;
}

/**
 * Resolves which referral code applies: an explicit one from the request wins,
 * otherwise whatever was parked on the guest session when the user followed an
 * invite link before creating an account.
 */
async function resolveReferralCode(
  explicit: string | undefined,
  guestSessionId: string | undefined,
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (!guestSessionId) return undefined;

  const [session] = await db
    .select({ referralCode: guestSessions.referralCode })
    .from(guestSessions)
    .where(eq(guestSessions.id, guestSessionId))
    .limit(1);

  return session?.referralCode ?? undefined;
}

/**
 * Circuit detection, run after the signup transaction has committed.
 *
 * Deliberately fire-and-forget: it reads and writes rows belonging to users far
 * outside the one signing up, and no scoring bug should ever be able to stop an
 * account being created. Attribution is the durable fact; circuits are derived
 * from it and can be recomputed at any time.
 */
function detectCircuitsInBackground(referredUserId: number): void {
  referralScoringService.detectCircuits(referredUserId).catch((err) => {
    logger.error('Circuit detection failed after signup', {
      referredUserId,
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
    guestSessionId: string | undefined,
    context: SignupContext = {},
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

    const referralCode = await resolveReferralCode(context.referralCode, guestSessionId);

    // Atomic: user + subscription committed together — if either insert fails,
    // neither row persists and the client can safely retry without hitting a 409.
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          name: name.trim(),
          email: email.toLowerCase().trim(),
          passwordHash,
          // Resolved once, here, and then frozen — see geo.service for why it is
          // never re-derived on later requests.
          countryCode: context.country?.code ?? null,
          countrySource: context.country?.source ?? 'unknown',
          countryResolvedAt: new Date(),
        })
        .returning({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified });
      const [sub] = await tx
        .insert(userSubscriptions)
        .values({ userId: u.id, tier: 'plus', status: 'trialing', trialEndsAt })
        .returning();
      await tx.insert(subscriptionEvents).values({ userId: u.id, event: 'started', newTrialEndsAt: trialEndsAt });
      // Opens the first history interval, so a user's state timeline starts at
      // signup rather than at whatever their first change happens to be.
      await subscriptionStateService.recordHistory(tx, sub, 'signup', null);
      await tx.insert(notificationPreferences).values({ userId: u.id });

      // Attribution rides the same transaction as the account it describes.
      // Written outside it, a referral row could survive a signup that rolled
      // back, or vanish while the account it belongs to persists.
      if (referralCode) {
        await referralsService.attributeSignup(tx, {
          referredUserId: u.id,
          code: referralCode,
          redeemerCountry: context.country?.code ?? null,
          channel: context.channel,
          clickId: context.clickId,
        });
      }

      return u;
    });

    if (referralCode) detectCircuitsInBackground(user.id);

    const tokens = await issueTokenPair(user.id, user.email);

    if (guestSessionId) {
      migrateGuestSession(user.id, guestSessionId).catch((err) => {
        logger.error('Guest session migration failed after signup', {
          guestSessionId,
          userId: user.id,
          error: (err as Error).message,
        });
      });
    }

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
   * Validates the 6-digit OTP for the authenticated user and marks their
   * email as verified. Scoped to userId so the OTP alone (a 1e6-value space)
   * is never sufficient to verify an arbitrary account. The OTP is
   * single-use — deleted on success.
   */
  async verifyEmail(userId: number, otp: string): Promise<void> {
    const [stored] = await db
      .select({
        id: emailVerificationTokens.id,
        otpHash: emailVerificationTokens.otpHash,
        expiresAt: emailVerificationTokens.expiresAt,
      })
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          gt(emailVerificationTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!stored || stored.otpHash !== hashToken(otp.trim())) {
      throw Object.assign(new Error('Invalid or expired verification code'), { statusCode: 400 });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx
        .delete(emailVerificationTokens)
        .where(eq(emailVerificationTokens.id, stored.id));
    });
  },

  /**
   * Resends the verification email for the authenticated user. No-op (but
   * still 200) if the email is already verified — issues a fresh OTP and
   * resets the 15-minute expiry otherwise.
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

  /**
   * Confirms a sensitive action is really being taken by the account owner,
   * not just whoever is holding a valid session token. Accepts either the
   * account password (for password-based accounts) or a fresh Firebase ID
   * token from the same social provider they signed up with (for accounts
   * with no password).
   *
   * "Fresh" is enforced by the caller's promise that this ID token comes
   * from a re-authentication the app just prompted for. Firebase's own
   * `auth_time` claim is checked against `MAX_TOKEN_AGE_SECONDS` below so a
   * long-lived token cached elsewhere on the device can't stand in for a
   * fresh sign-in.
   */
  async verifyOwnership(
    userId: number,
    credential: { password?: string; idToken?: string },
  ): Promise<void> {
    if (credential.password) {
      await this.verifyPassword(userId, credential.password);
      return;
    }
    if (credential.idToken) {
      await this.verifyFreshIdToken(userId, credential.idToken);
      return;
    }
    throw Object.assign(new Error('A password or a fresh sign-in is required'), {
      statusCode: 400,
    });
  },

  /**
   * Verifies a fresh Firebase ID token and confirms it belongs to a provider
   * account already linked to `userId`. Same guarantee as `verifyPassword`
   * for accounts that never had one.
   */
  async verifyFreshIdToken(userId: number, idToken: string): Promise<void> {
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      throw Object.assign(new Error('Invalid or expired sign-in token'), { statusCode: 401 });
    }

    // Freshness — a Firebase ID token stays valid for an hour, so `auth_time`
    // (when the user actually signed in) is what says whether this reflects
    // a real just-now re-auth or an hour-old cached login.
    const authTime = decoded.auth_time * 1000;
    if (Date.now() - authTime > MAX_TOKEN_AGE_SECONDS * 1000) {
      throw Object.assign(new Error('Sign in again to confirm this change'), { statusCode: 401 });
    }

    const provider = decoded.firebase.sign_in_provider;
    const providerUid = decoded.uid;

    const [linked] = await db
      .select({ id: userProviders.id })
      .from(userProviders)
      .where(
        and(
          eq(userProviders.userId, userId),
          eq(userProviders.provider, provider),
          eq(userProviders.providerUid, providerUid),
        ),
      )
      .limit(1);

    if (!linked) {
      // The token is valid Firebase but belongs to a different account
      // than the caller's session — treat identically to a wrong password,
      // so probing this endpoint can't reveal which provider account maps
      // to which internal user.
      throw Object.assign(new Error('Incorrect sign-in'), { statusCode: 401 });
    }
  },

  /**
   * Confirms a sensitive action is really being taken by the account owner,
   * not just whoever is holding a valid session token. Shared by every
   * password-confirmed flow (account deletion, changing subscription plan).
   */
  async verifyPassword(userId: number, password: string): Promise<void> {
    const [user] = await db
      .select({ passwordHash: users.passwordHash })
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
  },

  async deleteAccount(userId: number, password: string): Promise<void> {
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    await this.verifyPassword(userId, password);

    // Stop billing BEFORE the row goes. Deleting the user cascades away
    // user_subscriptions, and with it the only record of which Stripe
    // subscription belonged to them — so a subscription not cancelled by this
    // point carries on charging a card forever, with nothing left in our
    // database tying it back to anyone.
    //
    // This never throws. Deletion is a right the user is exercising, and
    // Stripe being unreachable is our problem, not a reason to refuse it; a
    // failure is logged loudly with every identifier needed to finish the job
    // by hand.
    await checkoutService.terminateForAccountDeletion(userId);

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
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    let [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .limit(1);

    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    // Lazy write: if the trial deadline has passed but nothing has flipped the
    // row yet (the cron sweep runs periodically, not instantly), do it now so
    // status/tier reflect reality and the transition is recorded. Returns null
    // if there was nothing to do or another writer got there first, in which
    // case the row we already read is still the truth.
    sub = (await subscriptionStateService.expireTrialIfDue(sub)) ?? sub;

    const providerRows = await db
      .select({ provider: userProviders.provider })
      .from(userProviders)
      .where(eq(userProviders.userId, userId));

    let trialDaysLeft: number | null = null;
    if (sub.status === 'trialing' && sub.trialEndsAt) {
      const msLeft = sub.trialEndsAt.getTime() - Date.now();
      trialDaysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    }

    const { createdAt, ...userFields } = user;

    return {
      ...userFields,
      joinedYear: createdAt.getFullYear(),
      subscription: {
        tier: sub.tier,
        status: sub.status,
        plan: sub.plan,
        trialDaysLeft,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
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
    context: SignupContext = {},
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

    // 3. Brand new user — guestSessionId is optional and, if given, migrates onboarding data
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + TRIAL_DAYS);

    const referralCode = await resolveReferralCode(context.referralCode, guestSessionId);

    // Atomic: user + provider link + subscription committed together.
    const newUser = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          name,
          email,
          photoUrl,
          emailVerified: true,
          countryCode: context.country?.code ?? null,
          countrySource: context.country?.source ?? 'unknown',
          countryResolvedAt: new Date(),
        })
        .returning({ id: users.id, name: users.name, email: users.email, emailVerified: users.emailVerified });
      await tx.insert(userProviders).values({ userId: u.id, provider, providerUid });
      const [sub] = await tx
        .insert(userSubscriptions)
        .values({ userId: u.id, tier: 'plus', status: 'trialing', trialEndsAt })
        .returning();
      await tx.insert(subscriptionEvents).values({ userId: u.id, event: 'started', newTrialEndsAt: trialEndsAt });
      await subscriptionStateService.recordHistory(tx, sub, 'signup', null);
      await tx.insert(notificationPreferences).values({ userId: u.id });

      // Social signup is a signup: it earns the referrer points exactly as the
      // email path does. Easy to overlook, and the two paths diverging would
      // mean a whole class of referral silently scoring nothing.
      if (referralCode) {
        await referralsService.attributeSignup(tx, {
          referredUserId: u.id,
          code: referralCode,
          redeemerCountry: context.country?.code ?? null,
          channel: context.channel,
          clickId: context.clickId,
        });
      }

      return u;
    });

    if (referralCode) detectCircuitsInBackground(newUser.id);

    const tokens = await issueTokenPair(newUser.id, newUser.email);

    if (guestSessionId) {
      migrateGuestSession(newUser.id, guestSessionId).catch((err) => {
        logger.error('Guest session migration failed after social login', {
          guestSessionId,
          userId: newUser.id,
          error: (err as Error).message,
        });
      });
    }

    enqueueEmail('welcome', { to: newUser.email, name: newUser.name }).catch((err) => {
      logger.error('Failed to enqueue welcome email after social signup', {
        userId: newUser.id,
        error: (err as Error).message,
      });
    });

    return { user: newUser, tokens, isNewUser: true };
  },
};
