import { z } from 'zod';

/**
 * Phone numbers, stored E.164 (`+233201234567`) and nothing else.
 *
 * One canonical form is worth insisting on because the number is a *delivery
 * contact*: it gets read by a courier, not by us. A number stored as the buyer
 * typed it — `+233 20 123 4567`, `020 123 4567`, `00233201234567` — is three
 * different strings for one phone, and the one that reaches Gardners has to be
 * dialable from anywhere.
 *
 * What this deliberately does not do is validate the number *exists*, or that
 * the country calling code matches the shipping country. Both need a real
 * library (libphonenumber) and a data file that ages; neither failure is worth
 * refusing a sale over. A typo'd but well-formed number is a delivery problem,
 * not a checkout problem.
 */

/** Anything a human might use to space a number out, plus the `00` IDD prefix. */
const SEPARATORS = /[\s().-]/g;

/**
 * E.164: a `+`, a country code that cannot start with zero, then digits, to a
 * maximum of 15 in total. The floor of 8 is a sanity check rather than a rule —
 * the shortest real international numbers are around that length, and anything
 * below it is a mistyped fragment.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalises what a form gives us into E.164, or returns null when it cannot.
 *
 * `00` is the international dialling prefix in most of the world and buyers use
 * it interchangeably with `+`, so it converts rather than failing. A bare
 * national number (`020 123 4567`) does **not** convert — guessing the country
 * from the shipping address would silently produce a wrong number, which is
 * worse than asking the buyer to include their country code.
 */
export function normalizePhone(input: string): string | null {
  const stripped = input.trim().replace(SEPARATORS, '');
  const e164 = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
  return E164.test(e164) ? e164 : null;
}

/**
 * Zod field for a phone the caller supplies. Normalises on the way through, so
 * everything downstream — column, Gardners record, receipt — sees E.164.
 *
 * Max length matches the `varchar(32)` columns it feeds, which is generous:
 * E.164 tops out at 16 characters including the `+`.
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a phone number in international format, e.g. +233201234567',
      });
      return z.NEVER;
    }
    return normalized;
  });
