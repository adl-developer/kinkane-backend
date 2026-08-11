/**
 * Is this request a link-preview fetcher or a crawler rather than a person?
 *
 * This exists because of how referral links actually travel. When someone pastes
 * a link into WhatsApp, iMessage, Slack or Telegram, the messaging service
 * fetches the URL server-side to build the preview card — and in a group chat it
 * may do so once per recipient. Those fetches hit the redirect endpoint exactly
 * as a human tap does. Left uncounted for, a link shared into one busy group
 * would report dozens of "clicks" nobody made.
 *
 * Preview traffic is still recorded, just flagged, so the rows remain available
 * for debugging ("did the link even get delivered?") without polluting the
 * number a user sees.
 */

// Named agents, matched as plain substrings on the lower-cased UA. Explicit
// names are safer than clever heuristics and this list is cheap to extend.
const KNOWN_AGENTS = [
  // Messaging / social link previews — the ones that actually matter here
  'whatsapp',
  'facebookexternalhit',
  'facebot',
  'slackbot',
  'slack-imgproxy',
  'twitterbot',
  'telegrambot',
  'discordbot',
  'linkedinbot',
  'skypeuripreview',
  'redditbot',
  'pinterest',
  'vkshare',
  'quora link preview',
  'iframely',
  'nuzzel',
  'xing-contenttabreceiver',
  'bitrix link preview',
  'snapchat',
  'viber',
  'line-podcast',
  // Search and infrastructure crawlers
  'googlebot',
  'google-inspectiontool',
  'bingbot',
  'duckduckbot',
  'yandexbot',
  'baiduspider',
  'applebot',
  'ahrefsbot',
  'semrushbot',
  'petalbot',
  'bytespider',
  // Scripted clients
  'curl/',
  'wget/',
  'python-requests',
  'go-http-client',
  'okhttp',
  'headlesschrome',
  'phantomjs',
  'axios/',
  'node-fetch',
  'postmanruntime',
];

/**
 * Generic fallback for agents not named above.
 *
 * The delimiters are load-bearing. A bare `includes('bot')` would flag every
 * visitor on a **Cubot** handset — a budget Android brand with real market share
 * in exactly the regions this competition is trying to reach — because its user
 * agent contains "CUBOT". Requiring a non-letter (or string boundary) either side
 * keeps "bot" from matching inside a longer word.
 */
const GENERIC = /(^|[^a-z])(bot|crawler|spider|scraper|preview|fetcher)([^a-z]|$)/;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  // A missing user agent is deliberately NOT treated as a bot. Plenty of
  // privacy-focused browsers and in-app webviews strip it, and silently
  // discarding those people's clicks is a worse error than counting a few
  // scripts — nothing here is defending prize money.
  if (!userAgent) return false;

  const ua = userAgent.toLowerCase();
  if (KNOWN_AGENTS.some((agent) => ua.includes(agent))) return true;
  return GENERIC.test(ua);
}
