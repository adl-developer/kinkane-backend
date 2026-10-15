import { describe, it, expect } from 'vitest';
import { escapeLike, likePrefix, likeWordPrefix, likeContains } from '../lib/escape-like';

// The patterns every search builds from typed text. Only the `%` each helper
// adds is a wildcard; whatever was typed matches literally.

describe('LIKE pattern helpers', () => {
  it('escapes the metacharacters, backslash first so it is not doubled twice', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });

  it('builds escaped prefix, word-prefix and contains patterns', () => {
    expect(likePrefix('100%')).toBe('100\\%%');
    expect(likeWordPrefix('a_b')).toBe('% a\\_b%');
    expect(likeContains('%%')).toBe('%\\%\\%%');
  });

  it('leaves ordinary text alone', () => {
    expect(likePrefix('Hunt')).toBe('Hunt%');
    expect(likeWordPrefix('Hunt')).toBe('% Hunt%');
    expect(likeContains('Hunt')).toBe('%Hunt%');
  });
});
