/**
 * Usernames: the rules, in one place, with no database.
 *
 * A username is the public handle a reader is mentioned by (`@ama_reads`). It is
 * stored lowercase and compared lowercase, so `Ama_Reads` and `ama_reads` are
 * the same name and only one person can hold it. Every path that accepts one —
 * signup, the availability check, the change endpoint — runs it through
 * `normalizeUsername` and `checkUsernameFormat` here, so the three can never
 * disagree about what is valid.
 *
 * ASCII only, on purpose. The database ctype is C, so Postgres would compare
 * accented letters byte-wise and `lower()` would leave them alone — `José` and
 * `josé` would be two different names. Keeping the alphabet to `a-z 0-9 _ .`
 * sidesteps that entirely, and it is also what keeps a handle typeable on every
 * keyboard someone might want to mention you from.
 */

import { z } from 'zod';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** Days between username changes, and how long a released name stays held for its old owner. */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 30;
export const USERNAME_HOLD_DAYS = 30;

/**
 * Letters, digits, underscores and dots; no leading, trailing or doubled dot.
 *
 * The dot rules are what keep a mention at the end of a sentence parseable —
 * "thanks @ama." must mean `ama` — and stop `a..b` from reading as a typo of
 * someone else's name.
 */
const USERNAME_PATTERN = /^[a-z0-9_](?:[a-z0-9_]|\.(?!\.))*[a-z0-9_]$/;

/**
 * Names nobody may hold. Mostly roles a reader could use to impersonate us or
 * our staff, plus the words a mention or a URL might mean something by
 * (`@everyone`, `/users/@me`). `deleted` is here because it is what a mention
 * of a deleted account renders as.
 */
const RESERVED = new Set([
  'about', 'account', 'admin', 'administrator', 'all', 'anonymous', 'api', 'app',
  'books', 'community', 'contact', 'deleted', 'everyone', 'groups', 'guest', 'help',
  'here', 'login', 'logout', 'me', 'mod', 'moderator', 'null', 'official', 'privacy',
  'root', 'security', 'settings', 'signup', 'staff', 'support', 'system', 'team',
  'terms', 'undefined', 'user', 'username', 'users', 'www',
]);

/** Any name containing the brand, in any position — `kinkane_support`, `official.kinkane`. */
const RESERVED_FRAGMENTS = ['kinkane'];

export type UsernameProblem = 'invalid_format' | 'reserved';

/** Trims, drops one leading `@` (people paste their handle with it), lowercases. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Null when `username` (already normalized) is acceptable as far as its shape
 * goes, otherwise why not. Says nothing about whether it is taken — that needs
 * the database.
 */
export function checkUsernameFormat(username: string): UsernameProblem | null {
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) return 'invalid_format';
  if (!USERNAME_PATTERN.test(username)) return 'invalid_format';
  if (RESERVED.has(username)) return 'reserved';
  if (RESERVED_FRAGMENTS.some((f) => username.includes(f))) return 'reserved';
  return null;
}

/** Human copy for a format problem, used in 400 responses. */
export function usernameProblemMessage(problem: UsernameProblem): string {
  return problem === 'reserved'
    ? 'That username is reserved'
    : `Usernames are ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters: letters, numbers, underscores and dots, not starting or ending with a dot`;
}

/** Longest base a generated name keeps, leaving room for a numeric suffix. */
const GENERATED_BASE_MAX = 15;
const GENERATED_FALLBACK = 'reader';

/**
 * The starting point for a username generated from a display name:
 * "José Mensah" → `josemensah`.
 *
 * Accents are stripped by decomposing (é → e + ◌́) and dropping the marks; a
 * few letters that do not decompose are spelled out. Anything else outside
 * a-z0-9 — spaces, punctuation, scripts with no Latin form — is dropped, and a
 * name that leaves fewer than three characters (an all-Arabic or all-CJK name,
 * or "Al") falls back to `reader`. The caller appends digits until it is free.
 *
 * A reserved result is swapped for the fallback too, so an account named
 * "Admin" or "Kinkane Fan" is never handed a name it could not have chosen.
 */
export function usernameBaseFromName(name: string): string {
  const spelled = name
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐðÐ]/g, 'd')
    .replace(/[þÞ]/g, 'th');

  const base = spelled
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, GENERATED_BASE_MAX);

  if (base.length < USERNAME_MIN_LENGTH) return GENERATED_FALLBACK;
  if (checkUsernameFormat(base) !== null) return GENERATED_FALLBACK;
  return base;
}

/**
 * The names to try for a generated username, in order: the bare base, then the
 * base with a short random number, widening as it goes. Random rather than
 * sequential so a popular first name does not need a hundred round trips to
 * find `ama101`, and so a generated name does not reveal how many people
 * signed up before you with the same name.
 */
export function generatedUsernameCandidates(base: string, random: () => number = Math.random): string[] {
  const out = [base];
  for (const digits of [2, 2, 3, 3, 4, 4, 5, 5]) {
    const n = Math.floor(random() * 10 ** digits);
    out.push(`${base}${String(n).padStart(digits, '0')}`.slice(0, USERNAME_MAX_LENGTH));
  }
  return out;
}

/** When someone who last changed their username at `changedAt` may change it again. */
export function nextUsernameChangeAt(changedAt: Date | null): Date | null {
  if (!changedAt) return null;
  return new Date(changedAt.getTime() + USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The optional `username` field on signup (email and social), as a request
 * schema. The shape is checked here so a bad one comes back under
 * `error.username` like every other field on the form; whether it is free is
 * the service's job (409 USERNAME_TAKEN). Normalized on the way through —
 * `@Ama_Reads` arrives as `ama_reads`.
 *
 * Blank counts as absent. Form libraries commonly send `""` for an optional
 * field nobody touched, and that has to mean "generate one for me", not a 400
 * that stops the account being created.
 */
export const optionalUsernameInput = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .max(64)
    .transform(normalizeUsername)
    .superRefine((value, ctx) => {
      const problem = checkUsernameFormat(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: usernameProblemMessage(problem) });
    })
    .optional(),
);
