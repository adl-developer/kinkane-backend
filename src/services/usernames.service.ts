import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { db, type Tx } from '../db';
import { users, usernameHolds } from '../db/schema';
import {
  USERNAME_HOLD_DAYS,
  checkUsernameFormat,
  generatedUsernameCandidates,
  nextUsernameChangeAt,
  normalizeUsername,
  usernameBaseFromName,
  usernameProblemMessage,
  type UsernameProblem,
} from '../lib/username';

export type UsernameUnavailableReason = UsernameProblem | 'taken' | 'too_soon';

/** GET /users/username-available. Always a 200 — `available` carries the answer. */
export interface UsernameAvailability {
  /** What would be saved: trimmed, `@` dropped, lowercased. */
  username: string;
  available: boolean;
  reason?: UsernameUnavailableReason;
  /** Set when this is already the caller's username. */
  current?: true;
  /** Set with `too_soon`: when the caller may next change their username. */
  nextChangeAt?: Date;
}

export interface UsernameChangeResult {
  username: string;
  usernameChangedAt: Date;
  nextChangeAt: Date;
}

type Handle = typeof db | Tx;

function httpError(statusCode: number, message: string, code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { statusCode, code, ...(details && { details }) });
}

/** The 23505 Postgres raises when two writers race for the same username. */
export function isUsernameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const pg = e?.code ? e : e?.cause;
  return pg?.code === '23505' && pg.constraint_name === 'idx_users_username';
}

/**
 * Which of `candidates` belong to someone other than `exceptUserId` — as their
 * current name, or as a name they gave up recently and still hold. One round
 * trip however many candidates: the two lookups run side by side.
 */
async function takenAmong(handle: Handle, candidates: string[], exceptUserId?: number): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const notMe = exceptUserId !== undefined;
  const [owned, held] = await Promise.all([
    handle
      .select({ username: users.username })
      .from(users)
      .where(and(inArray(users.username, candidates), notMe ? ne(users.id, exceptUserId) : undefined)),
    handle
      .select({ username: usernameHolds.username })
      .from(usernameHolds)
      .where(
        and(
          inArray(usernameHolds.username, candidates),
          gt(usernameHolds.expiresAt, sql`now()`),
          notMe ? ne(usernameHolds.userId, exceptUserId) : undefined,
        ),
      ),
  ]);
  return new Set([...owned.map((r) => r.username!), ...held.map((r) => r.username)]);
}

async function isTaken(handle: Handle, username: string, exceptUserId?: number): Promise<boolean> {
  return (await takenAmong(handle, [username], exceptUserId)).has(username);
}

/** `userId`'s unexpired hold on `username`, if they have one — i.e. a name they gave up and may take back. */
async function ownHold(handle: Handle, userId: number, username: string): Promise<{ expiresAt: Date } | undefined> {
  const [hold] = await handle
    .select({ expiresAt: usernameHolds.expiresAt })
    .from(usernameHolds)
    .where(
      and(eq(usernameHolds.username, username), eq(usernameHolds.userId, userId), gt(usernameHolds.expiresAt, sql`now()`)),
    )
    .limit(1);
  return hold;
}

export const usernamesService = {
  /**
   * The availability check behind the "choose a username" field. Answers for the
   * caller specifically: their own current name is available (and flagged
   * `current`), a name they are holding is available to them, and a caller
   * still inside the change cooldown is told `too_soon` with the date — so the
   * screen can say so before they type a whole name.
   *
   * `viewerId` is omitted for the signup screen, where nobody is signed in yet:
   * then it is purely "is this name free and valid".
   */
  async checkAvailability(raw: string, viewerId?: number): Promise<UsernameAvailability> {
    const username = normalizeUsername(raw);

    const problem = checkUsernameFormat(username);
    if (problem) return { username, available: false, reason: problem };

    if (viewerId !== undefined) {
      const [me] = await db
        .select({ username: users.username, changedAt: users.usernameChangedAt })
        .from(users)
        .where(eq(users.id, viewerId))
        .limit(1);

      if (me?.username === username) return { username, available: true, current: true };

      // Taking back a name you are holding is an undo, allowed even inside the
      // cooldown — see `change`.
      if (await ownHold(db, viewerId, username)) return { username, available: true };

      const nextChangeAt = nextUsernameChangeAt(me?.changedAt ?? null);
      if (nextChangeAt && nextChangeAt > new Date()) {
        return { username, available: false, reason: 'too_soon', nextChangeAt };
      }
    }

    if (await isTaken(db, username, viewerId)) return { username, available: false, reason: 'taken' };
    return { username, available: true };
  },

  /**
   * Validates a username chosen at signup and returns it normalized, or throws
   * the response to give. Checked before the account is created so a taken
   * name fails fast and cleanly; the unique index is still the final word if
   * two signups race for it (see isUsernameConflict).
   */
  async assertAvailableForSignup(raw: string): Promise<string> {
    const username = normalizeUsername(raw);
    const problem = checkUsernameFormat(username);
    if (problem) {
      throw httpError(400, usernameProblemMessage(problem), problem === 'reserved' ? 'USERNAME_RESERVED' : 'USERNAME_INVALID');
    }
    if (await isTaken(db, username)) throw usernameTakenError();
    return username;
  },

  /**
   * Gives a new account a username generated from its display name, inside the
   * signup transaction.
   *
   * Each attempt runs in its own savepoint: under concurrent signups two
   * people called Ama can both see `ama` free, and the loser's UPDATE fails on
   * the unique index. Without the savepoint that failure would abort the whole
   * signup transaction; with it, the attempt rolls back alone and the loop
   * moves to the next candidate.
   */
  async assignGenerated(tx: Tx, userId: number, name: string): Promise<string> {
    const candidates = [...new Set(generatedUsernameCandidates(usernameBaseFromName(name)))];
    // Every candidate checked in one go, so a common name costs one lookup
    // rather than one per name already taken.
    const taken = await takenAmong(tx, candidates);
    for (const candidate of candidates) {
      if (taken.has(candidate)) continue;
      try {
        await tx.transaction(async (sp) => {
          await sp.update(users).set({ username: candidate }).where(eq(users.id, userId));
        });
        return candidate;
      } catch (err) {
        if (isUsernameConflict(err)) continue;
        throw err;
      }
    }
    // Ten misses means a namespace far more crowded than any real one; a name
    // keyed on the account id cannot collide with another account's.
    const fallback = `reader${userId}`;
    await tx.update(users).set({ username: fallback }).where(eq(users.id, userId));
    return fallback;
  },

  /**
   * Changes the caller's username.
   *
   * Row-locked so two changes from the same account (a double tap, two
   * devices) are decided one after the other — otherwise both could pass the
   * cooldown check and the second would land a day later than allowed.
   *
   * The name given up is held for its old owner for USERNAME_HOLD_DAYS; see
   * usernameHolds.
   *
   * Taking back a name you are holding is an undo, and is allowed inside the
   * cooldown — otherwise the hold could never be used, since it lasts exactly
   * as long as the cooldown does. An undo neither restarts the cooldown nor
   * extends anything: the name you step off is held only until the reclaimed
   * hold would have expired, so flipping between two names cannot keep both
   * reserved for ever.
   *
   * Existing mentions need no work: they are stored by account id and render
   * as the new name from the next read.
   */
  async change(userId: number, raw: string): Promise<UsernameChangeResult> {
    const username = normalizeUsername(raw);
    const problem = checkUsernameFormat(username);
    if (problem) {
      throw httpError(422, usernameProblemMessage(problem), problem === 'reserved' ? 'USERNAME_RESERVED' : 'USERNAME_INVALID');
    }

    try {
      return await db.transaction(async (tx) => {
        const [me] = await tx
          .select({ username: users.username, changedAt: users.usernameChangedAt })
          .from(users)
          .where(eq(users.id, userId))
          .for('update')
          .limit(1);
        if (!me) throw httpError(404, 'User not found', 'USER_NOT_FOUND');

        if (me.username === username) {
          throw httpError(409, 'That is already your username', 'USERNAME_UNCHANGED');
        }

        const reclaimed = await ownHold(tx, userId, username);

        if (!reclaimed) {
          const nextAllowed = nextUsernameChangeAt(me.changedAt);
          if (nextAllowed && nextAllowed > new Date()) {
            throw httpError(429, 'You changed your username recently — try again later', 'USERNAME_CHANGE_TOO_SOON', {
              nextChangeAt: nextAllowed,
            });
          }
        }

        if (await isTaken(tx, username, userId)) throw usernameTakenError();

        const now = new Date();
        // An undo keeps the cooldown clock where the original change set it.
        const changedAt = reclaimed && me.changedAt ? me.changedAt : now;
        await tx.update(users).set({ username, usernameChangedAt: changedAt, updatedAt: now }).where(eq(users.id, userId));

        await tx
          .delete(usernameHolds)
          .where(and(eq(usernameHolds.username, username), eq(usernameHolds.userId, userId)));

        if (me.username) {
          const expiresAt = reclaimed
            ? reclaimed.expiresAt
            : new Date(now.getTime() + USERNAME_HOLD_DAYS * 24 * 60 * 60 * 1000);
          await tx
            .insert(usernameHolds)
            .values({ username: me.username, userId, expiresAt })
            .onConflictDoUpdate({ target: usernameHolds.username, set: { userId, expiresAt } });
        }

        return { username, usernameChangedAt: changedAt, nextChangeAt: nextUsernameChangeAt(changedAt)! };
      });
    } catch (err) {
      if (isUsernameConflict(err)) throw usernameTakenError();
      throw err;
    }
  },

  /** The account holding `username` right now, or null. Held names do not resolve — they belong to nobody yet. */
  async findUserId(raw: string): Promise<number | null> {
    const username = normalizeUsername(raw);
    if (checkUsernameFormat(username) === 'invalid_format') return null;
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    return row?.id ?? null;
  },
};

export function usernameTakenError(): Error {
  return httpError(409, 'That username is taken', 'USERNAME_TAKEN');
}
