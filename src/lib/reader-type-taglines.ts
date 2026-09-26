import type { ReaderType } from '../db/schema/users';

/**
 * The one-line tagline the app shows under each reader type.
 *
 * Copy comes from the product sheet "Kinkané App Reader Types". It is kept as
 * written there apart from three fixes: "emphatic" is corrected to "empathic",
 * stray whitespace is trimmed, and The Open Door gets the full stop every other
 * tagline has.
 *
 * Keyed by the enum rather than by string, so adding a reader type to
 * `readerTypeEnum` fails to compile until it has a tagline here.
 */
export const READER_TYPE_TAGLINES: Record<ReaderType, string> = {
  'The Open Door': "You're open to the world but discerning about what stays.",
  'The Seeker': 'You read to learn, and learn to provide meaning to life.',
  'The Book-ist':
    '"So many books, so little time": tackled with your determined organisation and unfailing optimism.',
  'The Story Circler': "You don't just read … you start conversations with your kin.",
  'The Mirror Within': 'Heart-driven, you seek empathic connection.',
  'The Echo Collector': 'Thoughtful; stories linger and accompany you on your journey.',
  'The High Summiter': 'Life is a challenge, to be questioned and won.',
  'The Cloud Illusionist': 'You seek the effortless to counter the challenge.',
};

/**
 * The tagline for a reader type, or null when there is no type. Reader type is
 * legitimately absent (onboarding never ran, or inference failed), and the
 * tagline follows it rather than inventing a fallback line.
 */
export function readerTypeTagline(readerType: ReaderType | null | undefined): string | null {
  return readerType ? READER_TYPE_TAGLINES[readerType] : null;
}
