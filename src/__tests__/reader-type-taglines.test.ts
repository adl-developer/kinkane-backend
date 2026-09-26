import { describe, it, expect } from 'vitest';
import { readerTypeEnum } from '../db/schema/users';
import { READER_TYPE_TAGLINES, readerTypeTagline } from '../lib/reader-type-taglines';

describe('reader type taglines', () => {
  it('has a non-empty, trimmed tagline for every reader type', () => {
    // The Record type already forces a key per enum value; this catches an
    // empty string or pasted whitespace, which the compiler cannot.
    for (const type of readerTypeEnum.enumValues) {
      const tagline = READER_TYPE_TAGLINES[type];
      expect(tagline, type).toBeTruthy();
      expect(tagline, type).toBe(tagline.trim());
    }
    expect(Object.keys(READER_TYPE_TAGLINES).sort()).toEqual([...readerTypeEnum.enumValues].sort());
  });

  it('returns the tagline for a type', () => {
    expect(readerTypeTagline('The Mirror Within')).toBe('Heart-driven, you seek empathic connection.');
  });

  it('returns null when there is no reader type', () => {
    expect(readerTypeTagline(null)).toBeNull();
    expect(readerTypeTagline(undefined)).toBeNull();
  });
});
