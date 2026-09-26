import type { PreferenceHistoryField, UserPreferenceHistory } from '../db/schema';

/**
 * The three preference screens in Profile (Mood preferences, Genre
 * preferences, What to avoid), each with its own History tab. This module
 * shapes a history snapshot into what one of those screens shows, so the app
 * renders the section rather than picking through a whole taste profile.
 */
export const PREFERENCE_SECTIONS = ['mood', 'genres', 'avoid'] as const;
export type PreferenceSection = (typeof PREFERENCE_SECTIONS)[number];

/** The snapshot field whose changes make up each section's timeline. */
export const SECTION_FIELD: Record<PreferenceSection, PreferenceHistoryField> = {
  mood: 'feelings',
  genres: 'genres',
  avoid: 'dislikes',
};

/**
 * The mood cards on the Mood preferences screen, in the design's order.
 *
 * `feelings` is stored open (preset labels and free text share one array, and
 * any string up to 200 characters is valid), so this list is the only way to
 * tell the reader's written prompt apart from the cards they tapped. It has to
 * track the app: a mood added there and not here comes back as a prompt rather
 * than a card.
 */
export const MOOD_PRESETS = [
  'comforted',
  'challenged',
  'escaped',
  'inspired',
  'understood',
  'energized',
  'reflective',
  'intellectual',
  'thrilled',
  'informed',
  'thoughtful',
  'emotional',
  'relaxed',
  'scared',
  'suspense',
] as const;

const MOOD_PRESET_SET = new Set<string>(MOOD_PRESETS);

/** Capitalises each word, including after a hyphen: "sci-fi" → "Sci-Fi". */
export function titleCase(key: string): string {
  return key.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Capitalises the first letter only: "too dark or heavy" → "Too dark or heavy". */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface MoodSection {
  /** What the reader wrote in the text box, or null if they only tapped cards. */
  prompt: string | null;
  /**
   * The mood cards selected, as a key for the icon and a label to show. `key`
   * is null only for extra free text that isn't the prompt (see below).
   */
  moods: { key: string | null; label: string }[];
}

/**
 * Splits `feelings` into the written prompt and the tapped cards.
 *
 * Matching is case-insensitive because clients have sent both "Comforted" and
 * "comforted". The first free-text entry is the prompt. A second one has
 * nowhere to go on the screen, so it is kept as a card with a null key rather
 * than dropped: the reader did choose it.
 */
export function moodSection(feelings: string[]): MoodSection {
  let prompt: string | null = null;
  const moods: MoodSection['moods'] = [];

  for (const raw of feelings) {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (MOOD_PRESET_SET.has(key)) {
      moods.push({ key, label: titleCase(key) });
    } else if (prompt === null) {
      prompt = text;
    } else {
      moods.push({ key: null, label: text });
    }
  }

  return { prompt, moods };
}

export interface GenreSection {
  genres: { key: string; label: string }[];
}

/** Genre keys are the validated lowercase enum; the label is what the card shows. */
export function genreSection(genres: string[]): GenreSection {
  return { genres: genres.map((key) => ({ key, label: titleCase(key) })) };
}

export interface AvoidSection {
  /** Every deal-breaker as one list of chips, as the history detail shows them. */
  dealBreakers: string[];
  /** The same choices under their category, for anything that needs the grouping. */
  categories: Record<string, string[]>;
}

/**
 * Flattens the categorised deal-breakers into the chip list the detail screen
 * shows. The same label can sit under two categories (the design repeats "Too
 * dark or heavy" under Emotional Tone and Content Sensitivity), and one chip
 * per label is what the reader expects, so duplicates are collapsed.
 */
export function avoidSection(dislikes: Record<string, string[]>): AvoidSection {
  const seen = new Set<string>();
  const dealBreakers: string[] = [];
  for (const labels of Object.values(dislikes)) {
    for (const label of labels) {
      const key = label.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dealBreakers.push(sentenceCase(label.trim()));
    }
  }
  return { dealBreakers, categories: dislikes };
}

/** One history entry, shaped for the given section's screen. */
export function sectionEntry(section: PreferenceSection, row: UserPreferenceHistory) {
  const base = { id: row.id, recordedAt: row.recordedAt };
  switch (section) {
    case 'mood':
      return { ...base, ...moodSection(row.feelings) };
    case 'genres':
      return { ...base, ...genreSection(row.genres) };
    case 'avoid':
      return { ...base, ...avoidSection(row.dislikes) };
  }
}
