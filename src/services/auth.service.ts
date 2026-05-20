import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db';
import { users, refreshTokens, userProviders } from '../db/schema';
import { config } from '../config';
import { admin } from '../lib/firebase';

const BCRYPT_ROUNDS = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: number;
  fullName: string;
  email: string;
  emailVerified: boolean;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

function signAccessToken(userId: number, email: string): string {
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

export const authService = {
  async signup(
    fullName: string,
    email: string,
    password: string,
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

    const [user] = await db
      .insert(users)
      .values({
        fullName: fullName.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
      })
      .returning({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        emailVerified: users.emailVerified,
      });

    const tokens = await issueTokenPair(user.id, user.email);

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
        fullName: user.fullName,
        email: user.email,
        emailVerified: user.emailVerified,
      },
      tokens,
    };
  },

  async refresh(rawToken: string): Promise<{ accessToken: string }> {
    const tokenHash = hashToken(rawToken);

    const [stored] = await db
      .select({ id: refreshTokens.id, userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!stored) {
      throw Object.assign(new Error('Invalid or expired refresh token'), { statusCode: 401 });
    }

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, stored.userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 401 });
    }

    const accessToken = signAccessToken(user.id, user.email);
    return { accessToken };
  },

  async logout(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
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
    const fullName = decoded.name ?? '';
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
        .select({ id: users.id, fullName: users.fullName, email: users.email, emailVerified: users.emailVerified })
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
        user: { id: existingUser.id, fullName: existingUser.fullName, email: existingUser.email, emailVerified: true },
        tokens,
        isNewUser: false,
      };
    }

    // 3. Brand new user
    const [newUser] = await db
      .insert(users)
      .values({ fullName, email, photoUrl, emailVerified: true })
      .returning({ id: users.id, fullName: users.fullName, email: users.email, emailVerified: users.emailVerified });

    await db.insert(userProviders).values({ userId: newUser.id, provider, providerUid });

    const tokens = await issueTokenPair(newUser.id, newUser.email);
    return { user: newUser, tokens, isNewUser: true };
  },
};
