import { config } from '../config';

/**
 * The prefix every link meant to open the mobile app sits under.
 *
 * One prefix means the association files (`apple-app-site-association`,
 * `assetlinks.json`) register a single pattern, `/redirect/*`, instead of a list
 * of paths that has to be kept in step with every email this server sends. A
 * link that forgets the prefix doesn't break — it opens the web page instead of
 * the app — so build app links here rather than from `config.appUrl` directly.
 *
 * In a browser, `/redirect/<path>` is forwarded to `/<path>` by the route in
 * `routes/app-link-redirect.routes.ts`.
 */
export const APP_LINK_PREFIX = '/redirect';

/**
 * `APP_URL/redirect<path>`. `path` starts with a slash and may carry a query
 * string; omit it for the app's home.
 */
export function appLink(path = ''): string {
  return `${config.appUrl}${APP_LINK_PREFIX}${path}`;
}
