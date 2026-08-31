import { describe, it, expect } from 'vitest';
import { isBotUserAgent } from '../lib/user-agent';
import { clickSchema } from '../controllers/referrals.controller';

// Referral links live in group chats, and every messaging app fetches a URL
// server-side to build its preview card — sometimes once per recipient. Those
// fetches are indistinguishable from a tap except by user agent, so this
// function is the only thing standing between "37 clicks" and "three people
// actually opened it".

describe('isBotUserAgent', () => {
  it('flags the link-preview fetchers that referral links actually meet', () => {
    const previewers = [
      'WhatsApp/2.23.20.0 A',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'TelegramBot (like TwitterBot)',
      'Twitterbot/1.0',
      'Discordbot/2.0 (+https://discordapp.com)',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
      'SkypeUriPreview Preview/0.5',
    ];
    for (const ua of previewers) expect(isBotUserAgent(ua)).toBe(true);
  });

  it('flags crawlers and scripted clients', () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'PostmanRuntime/7.36.0',
      'Go-http-client/1.1',
    ];
    for (const ua of bots) expect(isBotUserAgent(ua)).toBe(true);
  });

  it('does not flag a Cubot handset as a bot', () => {
    // The reason the generic pattern requires delimiters rather than a bare
    // includes('bot'). Cubot is a budget Android brand with real market share in
    // exactly the regions this competition is trying to reach — matching "bot"
    // inside "CUBOT" would silently zero those users' clicks.
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0 Mobile Safari/537.36',
      ),
    ).toBe(false);
  });

  it('does not flag ordinary browsers', () => {
    const humans = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ];
    for (const ua of humans) expect(isBotUserAgent(ua)).toBe(false);
  });

  it('treats a missing user agent as a person, not a bot', () => {
    // Privacy browsers and some in-app webviews strip the header. Discarding
    // those clicks is a worse error than counting a few scripts — there is no
    // prize money here to defend.
    expect(isBotUserAgent(undefined)).toBe(false);
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBotUserAgent('WHATSAPP/2.0')).toBe(true);
    expect(isBotUserAgent('whatsapp/2.0')).toBe(true);
  });
});

describe('clickSchema — referralCode vs the deprecated code alias', () => {
  // This endpoint is called by *installed* app builds, which cannot be updated
  // retroactively. The alias is the only thing standing between a field rename
  // and clicks silently dropping to zero from every app already in the wild —
  // and since the endpoint answers 202 regardless, nothing would look broken.
  it('accepts the canonical referralCode', () => {
    const parsed = clickSchema.safeParse({ referralCode: 'K7M2QX4B9C', channel: 'app' });
    expect(parsed.success && parsed.data.referralCode).toBe('K7M2QX4B9C');
  });

  it('still accepts a legacy code and normalises it to referralCode', () => {
    const parsed = clickSchema.safeParse({ code: 'K7M2QX4B9C' });
    expect(parsed.success && parsed.data.referralCode).toBe('K7M2QX4B9C');
  });

  it('prefers referralCode when a client sends both', () => {
    const parsed = clickSchema.safeParse({ referralCode: 'NEWCODE123', code: 'OLDCODE456' });
    expect(parsed.success && parsed.data.referralCode).toBe('NEWCODE123');
  });

  it('rejects a body carrying neither', () => {
    expect(clickSchema.safeParse({ channel: 'app' }).success).toBe(false);
  });

  it('rejects a malformed code under either name', () => {
    expect(clickSchema.safeParse({ referralCode: 'no!' }).success).toBe(false);
    expect(clickSchema.safeParse({ code: 'no!' }).success).toBe(false);
  });
});
