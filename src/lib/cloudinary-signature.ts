import { createHash } from 'crypto';

/**
 * Signs a set of Cloudinary upload parameters.
 *
 * Cloudinary's rule: every field sent with the upload except `file`,
 * `cloud_name`, `resource_type` and `api_key` is signed — sorted by name,
 * joined as `name=value&…`, the API secret appended with no separator, then
 * SHA-1'd. Any field the client adds, drops or changes after signing makes
 * Cloudinary reject the upload, which is what pins the client to the
 * `public_id` (and so the folder) we chose.
 *
 * Hand-rolled rather than pulling in the Cloudinary SDK for one hash.
 */
export function signUploadParams(
  params: Record<string, string | number | boolean>,
  apiSecret: string,
): string {
  const toSign = Object.keys(params)
    .filter((k) => !['file', 'cloud_name', 'resource_type', 'api_key'].includes(k))
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(toSign + apiSecret).digest('hex');
}
