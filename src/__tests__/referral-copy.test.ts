import { describe, it, expect, afterEach, vi } from 'vitest';
import { shortMessage, emailCopy, emailPlainText } from '../lib/referral-copy';

// This is marketing copy held verbatim, which makes it unusually easy to break
// silently: a stray "fix" to an em dash or a curly apostrophe changes what goes
// out to every invited reader and nothing else in the system notices. These
// assert the exact strings, and the campaign switch that chooses between them.

const BASE_ENV = { ...process.env };

async function loadCopy(overrides: Record<string, string>) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../lib/referral-copy');
}

afterEach(() => {
  process.env = { ...BASE_ENV };
});

const LINK = 'https://kinkane.app/r/K7M3QP9XVT/jason-appiatu';

describe('shortMessage', () => {
  it('is the launch campaign copy, verbatim', () => {
    expect(shortMessage(LINK, 'launch')).toBe(
      `📚 Come on a reading adventure with me! Find your next great read on Kinkané — and help me travel Around the World in 80 Days 🌍 ${LINK}`,
    );
  });

  it('is the evergreen copy, verbatim', () => {
    expect(shortMessage(LINK, 'evergreen')).toBe(
      `📚 Fellow book lover — you have to try this. Kinkané helps you find books based on your taste + mood. See what it picks for you: ${LINK}`,
    );
  });

  it('ends with the link in both sets, so a chat client can autolink it', () => {
    // A trailing link is what makes WhatsApp and iMessage turn it into a tappable
    // preview. Copy edits that append anything after it would break that.
    expect(shortMessage(LINK, 'launch').endsWith(LINK)).toBe(true);
    expect(shortMessage(LINK, 'evergreen').endsWith(LINK)).toBe(true);
  });
});

describe('emailCopy', () => {
  it('uses the launch subject and closes on the journey line', () => {
    const copy = emailCopy('launch');
    expect(copy.subject).toBe('Come on a reading adventure with me 🌍📚');
    expect(copy.before[0]).toBe('Hey!');
    expect(copy.before[1]).toBe(
      'I’m taking Kinkané’s Around the World in 80 Days challenge, and I’d love for you to join me.',
    );
    expect(copy.after).toEqual([
      'Every reader who joins through my link moves me one step further on my journey around the world. 🌍',
      'Happy reading! 📚',
    ]);
  });

  it('uses the evergreen subject and its shorter body', () => {
    const copy = emailCopy('evergreen');
    expect(copy.subject).toBe('I think you’ll like this 📚');
    expect(copy.after).toEqual(['Happy reading! 📖']);
  });

  it('keeps the deliberate line break in the evergreen body', () => {
    // "Take the quiz..." runs on directly under the previous line rather than
    // starting a new paragraph — that is how the copy was written.
    expect(emailCopy('evergreen').before[1]).toContain('\nTake the quiz');
  });

  it('uses the same call to action in both sets', () => {
    expect(emailCopy('launch').ctaLabel).toBe('Find your next read →');
    expect(emailCopy('evergreen').ctaLabel).toBe('Find your next read →');
  });

  it('uses curly apostrophes, not straight ones', () => {
    // The copy was supplied with typographic apostrophes throughout. A linter or
    // a well-meaning edit that straightens them would change what readers see.
    const all = [emailCopy('launch'), emailCopy('evergreen')]
      .flatMap((c) => [c.subject, ...c.before, ...c.after])
      .join(' ');
    expect(all).not.toContain("'");
  });
});

describe('emailPlainText', () => {
  it('replaces the CTA button with the real link', () => {
    // The text/plain part has no button to click, so the label has to be
    // followed by the URL itself or the mail is a dead end for anyone whose
    // client blocks HTML.
    const text = emailPlainText(emailCopy('launch'), LINK);
    expect(text).toContain('Find your next read →\n' + LINK);
    expect(text.startsWith('Hey!')).toBe(true);
    expect(text.trimEnd().endsWith('Happy reading! 📚')).toBe(true);
  });
});

describe('activeCampaign', () => {
  it('uses launch copy while the campaign window is open', async () => {
    const { activeCampaign } = await loadCopy({ REFERRAL_CAMPAIGN_ENDS_AT: '2099-01-01T00:00:00Z' });
    expect(activeCampaign()).toBe('launch');
  });

  it('falls back to evergreen once the window has closed', async () => {
    const { activeCampaign } = await loadCopy({ REFERRAL_CAMPAIGN_ENDS_AT: '2020-01-01T00:00:00Z' });
    expect(activeCampaign()).toBe('evergreen');
  });

  it('defaults to evergreen when unconfigured', async () => {
    // The safe default: launch copy promises an "Around the World in 80 Days"
    // challenge, and sending that when no campaign is running would be a
    // promise the product does not keep.
    const env = { ...BASE_ENV };
    delete env.REFERRAL_CAMPAIGN_ENDS_AT;
    vi.resetModules();
    process.env = env;
    const { activeCampaign } = await import('../lib/referral-copy');
    expect(activeCampaign()).toBe('evergreen');
  });
});
