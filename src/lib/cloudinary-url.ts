import { config } from '../config';

export const CLOUDINARY_HOSTNAME = 'res.cloudinary.com';

/**
 * True when `url` points at an image in *our* Cloudinary account.
 *
 * The server never receives an upload — the client uploads straight to
 * Cloudinary and sends us the resulting URL — so this check is the only thing
 * standing between a user-supplied string and a stored image reference.
 *
 * Both halves matter. The hostname alone would let anyone store a link to any
 * image on Cloudinary's shared domain, including another tenant's; the path
 * prefix pins it to our cloud name. Dropping either one re-opens hotlinking,
 * which is why this lives in one place rather than being re-typed per caller.
 *
 * Never throws: an unparseable string is simply not a Cloudinary URL.
 */
export function isCloudinaryUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.hostname === CLOUDINARY_HOSTNAME &&
    parsed.pathname.startsWith(`/${config.cloudinary.cloudName}/`)
  );
}

/** The `message` every zod `.refine(isCloudinaryUrl, …)` should use, so the wording matches. */
export function cloudinaryUrlMessage(field: string): string {
  return `${field} must be a ${CLOUDINARY_HOSTNAME}/<cloud-name>/ URL`;
}
