/**
 * The longest each kind of user-written text may be, in characters as the
 * reader sees it.
 *
 * One place, because two checks use the same numbers: the request schemas
 * (what was typed) and mentionsService.prepare (what it will read as once its
 * links are shortened). A short link can be longer than the address typed —
 * `www.bbc.co.uk` shows as a 34-character `https://www.kinkane.app/s/…` — so
 * text that fits as typed can render longer than the limit, and an edit that
 * sends back exactly what was shown would then be refused.
 */
export const TEXT_LIMITS = {
  post: 5000,
  comment: 2000,
  groupDescription: 2000,
  groupBookDescription: 2000,
  groupComment: 2000,
  bookNote: 1000,
} as const;
