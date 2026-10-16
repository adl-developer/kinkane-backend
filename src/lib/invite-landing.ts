/**
 * Where a referral link sends someone who doesn't have the app yet.
 *
 * There is no web sign-up from an invite: the account has to be made in the
 * app, so the link's job is to get the app installed with the code still
 * attached.
 *
 * - Android goes straight to the Play Store with the code in the install
 *   referrer, which the app reads on first launch and prefills into signup.
 * - iPhone has no install referrer, and Safari only lets a page copy to the
 *   clipboard after a tap, so it gets a page showing the code to type at
 *   signup, with an App Store button.
 * - Anything else (a computer, an iPad that reports itself as a Mac) gets the
 *   same page with both store buttons.
 *
 * Phones that already have the app never reach this: the OS opens the app from
 * the universal/app link without making the request.
 */

export type InvitePlatform = 'android' | 'ios' | 'other';

// The channels the app tags its share links with. Anything else in `?c=` is
// dropped rather than forwarded into the Play Store referrer.
const KNOWN_CHANNELS = new Set(['whatsapp', 'sms', 'email', 'copy', 'link']);

export function knownChannel(channel: string | undefined): string | undefined {
  return channel && KNOWN_CHANNELS.has(channel) ? channel : undefined;
}

export function detectInvitePlatform(userAgent: string | undefined): InvitePlatform {
  const ua = userAgent ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipod|ipad/i.test(ua)) return 'ios';
  return 'other';
}

/**
 * The Play Store listing with `referrer=ref=CODE&c=CHANNEL`. The referrer is
 * one parameter whose value is itself a query string, so it is encoded once
 * more: `referrer=ref%3DCODE%26c%3Dwhatsapp`.
 */
export function playStoreInviteUrl(listingUrl: string, code: string, channel: string | undefined): string {
  const referrer = new URLSearchParams({ ref: code });
  if (channel) referrer.set('c', channel);
  const url = new URL(listingUrl);
  url.searchParams.set('referrer', referrer.toString());
  return url.toString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page for iPhone and computers: the code, and the store buttons that fit
 * the device. No script, so it renders under the default CSP. An App Store
 * button is only shown once APP_STORE_URL is configured; until then the page
 * tells them to search for the app instead of linking somewhere wrong.
 */
export function inviteLandingPage(params: {
  code: string;
  platform: Exclude<InvitePlatform, 'android'>;
  appStoreUrl?: string;
  playStoreUrl: string;
}): string {
  const code = escapeHtml(params.code);
  const buttons: string[] = [];
  if (params.appStoreUrl) {
    buttons.push(`<a class="btn" href="${escapeHtml(params.appStoreUrl)}">Download on the App Store</a>`);
  }
  if (params.platform === 'other') {
    buttons.push(`<a class="btn" href="${escapeHtml(params.playStoreUrl)}">Get it on Google Play</a>`);
  }
  const fallback = params.appStoreUrl ? '' : '<p class="muted">Search for “Kinkané” in the App Store.</p>';

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>You’re invited · Kinkané</title>` +
    `<style>` +
    `body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;text-align:center}` +
    `.code{font:600 2rem/1.2 ui-monospace,monospace;letter-spacing:.15em;padding:.75rem 1rem;border:2px dashed #999;border-radius:.5rem;display:inline-block;margin:.5rem 0 1rem;user-select:all;-webkit-user-select:all}` +
    `.btn{display:block;margin:.75rem auto;max-width:18rem;padding:.8rem 1rem;border-radius:.5rem;background:#111;color:#fff;text-decoration:none;font-weight:600}` +
    `.muted{color:#666}` +
    `</style></head><body>` +
    `<h1>You’re invited to Kinkané</h1>` +
    `<p>Your referral code:</p><div class="code">${code}</div>` +
    `<p>Get the app, then enter this code when you sign up.</p>` +
    buttons.join('') +
    fallback +
    `</body></html>`
  );
}
