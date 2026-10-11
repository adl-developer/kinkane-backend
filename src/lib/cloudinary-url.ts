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

/** What a signed upload is for — decides the folder it is pinned to. */
export type UploadKind = 'user' | 'group' | 'upload';

const KIND_SEGMENT: Record<UploadKind, string> = {
  user: 'users',
  group: 'groups',
  upload: 'uploads',
};

/**
 * The Media Library folder a signed upload of `kind` is filed under, e.g.
 * `kinkane/users`. One per kind rather than per owner: thousands of one-image
 * folders would be unbrowsable, and the public ID already names the owner.
 *
 * Only for browsing. Ownership is checked against the public ID path (see
 * `uploadFolder`), never this. On dynamic-folder accounts the two are
 * independent, and the asset folder can be changed later in the console.
 */
export function uploadAssetFolder(kind: UploadKind): string {
  return `${config.cloudinary.uploadRoot}/${KIND_SEGMENT[kind]}`;
}

/**
 * The public ID path a signed upload of `kind` for `ownerId` lands in, e.g.
 * `kinkane/users/42`. A user ID for 'user' and 'upload', a group ID for 'group'.
 */
export function uploadFolder(kind: UploadKind, ownerId: number): string {
  return `${config.cloudinary.uploadRoot}/${KIND_SEGMENT[kind]}/${ownerId}`;
}

/**
 * True when `url` is an image delivered from directly inside one of `folders`.
 *
 * Deliberately narrow: it matches the `secure_url` Cloudinary returns from an
 * upload — `/<cloud>/image/upload/v<version>/<folder>/<file>` — and nothing
 * else. No transformation segments, no nested sub-folders. Each extra shape we
 * accepted would be a way to dress up a path outside the folder (a fake
 * "transformation" segment that is really a folder name) as one inside it.
 * Clients that want a resized image transform it at display time, not in what
 * they store.
 */
export function isCloudinaryUrlInFolders(url: string, folders: string[]): boolean {
  if (!isCloudinaryUrl(url)) return false;
  const { pathname } = new URL(url);
  const prefix = `/${config.cloudinary.cloudName}/image/upload/`;
  if (!pathname.startsWith(prefix)) return false;

  const segments = pathname.slice(prefix.length).split('/');
  const [version, ...rest] = segments;
  if (!/^v\d+$/.test(version) || rest.length < 2) return false;

  const file = rest[rest.length - 1];
  const folder = rest.slice(0, -1).join('/');
  return file.length > 0 && folders.includes(folder);
}

/**
 * The 400 a controller should send when a submitted photo URL wasn't signed for
 * this caller, or null when it's fine. Shaped like zod's flattened fieldErrors
 * so clients see one error format for photoUrl whichever check failed.
 *
 * A no-op until CLOUDINARY_REQUIRE_SIGNED_UPLOADS is on: app builds that still
 * use the unsigned preset can't produce URLs in these folders, and the existing
 * own-cloud check (isCloudinaryUrl, in the zod schema) still applies to them.
 * Clearing a photo (null) is always allowed.
 */
export function unsignedPhotoUrlError(
  photoUrl: string | null | undefined,
  folders: string[],
): { photoUrl: string[] } | null {
  if (!config.cloudinary.requireSignedUploads || photoUrl == null) return null;
  if (isCloudinaryUrlInFolders(photoUrl, folders)) return null;
  return { photoUrl: ['photoUrl must be an image uploaded with a signature from POST /uploads/signature'] };
}
