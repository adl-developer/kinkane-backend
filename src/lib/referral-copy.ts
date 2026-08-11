import { config } from '../config';

/**
 * The words on every referral invite, in both of their forms.
 *
 * There are two copy sets: one for the "Around the World in 80 Days" launch
 * campaign, and an evergreen one for after it ends. They live here rather than
 * inside the share-payload builder or the email template because both of those
 * need the same words and they must not be allowed to drift — a user who copies
 * the WhatsApp text and a user who sends the email should be sending the same
 * message.
 *
 * Marketing copy, kept verbatim. Emoji, em dashes and curly apostrophes are all
 * deliberate: this is the text as written, not as a developer would punctuate
 * it. Don't "fix" the typography.
 */

export type Campaign = 'launch' | 'evergreen';

/**
 * Which copy set is in force.
 *
 * Driven by REFERRAL_CAMPAIGN_ENDS_AT, mirroring how FOUNDING_OFFER_ENDS_AT
 * gates launch pricing. Unset means the campaign is over (or was never
 * configured) and everyone gets the evergreen copy — the safe default, since the
 * launch copy promises a challenge that might not be running.
 */
export function activeCampaign(now: Date = new Date()): Campaign {
  const endsAt = config.referrals.campaignEndsAt;
  return endsAt && now < endsAt ? 'launch' : 'evergreen';
}

/** The one-liner for SMS, WhatsApp and the copy-to-clipboard button. */
export function shortMessage(link: string, campaign: Campaign): string {
  return campaign === 'launch'
    ? `📚 Come on a reading adventure with me! Find your next great read on Kinkané — and help me travel Around the World in 80 Days 🌍 ${link}`
    : `📚 Fellow book lover — you have to try this. Kinkané helps you find books based on your taste + mood. See what it picks for you: ${link}`;
}

export interface EmailCopy {
  subject: string;
  /** Paragraphs before the call-to-action button. */
  before: string[];
  ctaLabel: string;
  /** Paragraphs after it. */
  after: string[];
}

export function emailCopy(campaign: Campaign): EmailCopy {
  if (campaign === 'launch') {
    return {
      subject: 'Come on a reading adventure with me 🌍📚',
      before: [
        'Hey!',
        'I’m taking Kinkané’s Around the World in 80 Days challenge, and I’d love for you to join me.',
        'Kinkané helps you discover your next great read based on your tastes, mood, and what you’re looking for right now.',
        'Use my link to take the quiz and see where your next book takes you:',
      ],
      ctaLabel: 'Find your next read →',
      after: [
        'Every reader who joins through my link moves me one step further on my journey around the world. 🌍',
        'Happy reading! 📚',
      ],
    };
  }

  return {
    subject: 'I think you’ll like this 📚',
    before: [
      'Hey!',
      // One paragraph, two lines — as written. The line break before "Take the
      // quiz" is part of the copy, not an accident of formatting.
      'I found Kinkané, a fun way to discover your next read based on your taste, mood, and what you actually like to read.\nTake the quiz and see what books it picks for you:',
    ],
    ctaLabel: 'Find your next read →',
    after: ['Happy reading! 📖'],
  };
}

/** Plain-text rendering, for the text/plain part of the email. */
export function emailPlainText(copy: EmailCopy, link: string): string {
  return [...copy.before, `${copy.ctaLabel}\n${link}`, ...copy.after].join('\n\n');
}
