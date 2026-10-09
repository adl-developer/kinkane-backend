import { describe, it, expect } from 'vitest';
import {
  checkUsernameFormat,
  generatedUsernameCandidates,
  nextUsernameChangeAt,
  normalizeUsername,
  optionalUsernameInput,
  usernameBaseFromName,
  USERNAME_MAX_LENGTH,
} from '../lib/username';

/**
 * The username rules. Signup, the availability check and the change endpoint
 * all run through these, so a rule pinned here is pinned everywhere a name can
 * enter the system.
 */

describe('normalizeUsername', () => {
  it('trims, drops one leading @ and lowercases', () => {
    expect(normalizeUsername('  @Ama_Reads ')).toBe('ama_reads');
  });

  it('drops only one @ — a second one is part of what was typed, and invalid', () => {
    expect(normalizeUsername('@@ama')).toBe('@ama');
    expect(checkUsernameFormat(normalizeUsername('@@ama'))).toBe('invalid_format');
  });
});

describe('checkUsernameFormat', () => {
  it.each(['ama', 'ama_reads', 'ama.reads', 'a_b', '123', 'x'.repeat(USERNAME_MAX_LENGTH)])('accepts %s', (name) => {
    expect(checkUsernameFormat(name)).toBeNull();
  });

  it.each([
    ['too short', 'am'],
    ['too long', 'x'.repeat(USERNAME_MAX_LENGTH + 1)],
    ['uppercase (callers normalize first)', 'Ama'],
    ['a space', 'ama reads'],
    ['a hyphen', 'ama-reads'],
    ['an accent — the database compares bytes, so é would not equal é', 'josé'],
    ['a leading dot', '.ama'],
    ['a trailing dot, which would swallow the full stop after a mention', 'ama.'],
    ['a doubled dot', 'ama..reads'],
    ['an @', 'ama@reads'],
  ])('rejects %s', (_why, name) => {
    expect(checkUsernameFormat(name)).toBe('invalid_format');
  });

  it.each(['admin', 'support', 'everyone', 'deleted', 'staff'])('reserves %s', (name) => {
    expect(checkUsernameFormat(name)).toBe('reserved');
  });

  it('reserves anything containing the brand, wherever it appears', () => {
    expect(checkUsernameFormat('kinkane')).toBe('reserved');
    expect(checkUsernameFormat('kinkane_help')).toBe('reserved');
    expect(checkUsernameFormat('the.kinkane.team')).toBe('reserved');
  });
});

describe('usernameBaseFromName', () => {
  it.each([
    ['José Mensah', 'josemensah'],
    ['Ama Owusu', 'amaowusu'],
    ["Chinua O'Brien-Achebe", 'chinuaobrienache'.slice(0, 15)],
    ['Zoë Ångström', 'zoeangstrom'],
    ['Søren Łukasz', 'sorenlukasz'],
    ['Straße', 'strasse'],
    ['Æsir', 'aesir'],
  ])('%s → %s', (name, expected) => {
    expect(usernameBaseFromName(name)).toBe(expected);
  });

  it('caps the base at 15 characters, leaving room for a numeric suffix', () => {
    expect(usernameBaseFromName('Oluwaseun Adebayo-Williams')).toBe('oluwaseunadebay');
  });

  it.each([
    ['a name with no Latin letters', '李小龙'],
    ['a name too short to use', 'Al'],
    ['an empty name (a social account with no display name)', ''],
    ['a name that is a reserved word', 'Admin'],
    ['a name containing the brand', 'Kinkane Fan'],
  ])('falls back to reader for %s', (_why, name) => {
    expect(usernameBaseFromName(name)).toBe('reader');
  });

  it('always produces a valid username', () => {
    for (const name of ['José', 'Ngozi Chukwu', '___', 'A. B. C.', 'Åsa', '12345678901234567890']) {
      expect(checkUsernameFormat(usernameBaseFromName(name))).toBeNull();
    }
  });
});

describe('generatedUsernameCandidates', () => {
  it('tries the bare base first, then the base with a widening random suffix', () => {
    const candidates = generatedUsernameCandidates('ama', () => 0.5);
    expect(candidates[0]).toBe('ama');
    expect(candidates.slice(1)).toEqual(['ama50', 'ama50', 'ama500', 'ama500', 'ama5000', 'ama5000', 'ama50000', 'ama50000']);
  });

  it('keeps every candidate within the maximum length and valid', () => {
    const base = usernameBaseFromName('Oluwaseun Adebayo-Williams');
    for (const c of generatedUsernameCandidates(base, () => 0.99999)) {
      expect(c.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
      expect(checkUsernameFormat(c)).toBeNull();
    }
  });

  it('zero-pads small numbers so a suffix never looks like a different length', () => {
    expect(generatedUsernameCandidates('ama', () => 0.01)[1]).toBe('ama01');
  });
});

describe('nextUsernameChangeAt', () => {
  it('is null for someone who has never chosen a username — a generated one is free to replace', () => {
    expect(nextUsernameChangeAt(null)).toBeNull();
  });

  it('is thirty days after the last change', () => {
    const changed = new Date('2026-10-01T12:00:00Z');
    expect(nextUsernameChangeAt(changed)).toEqual(new Date('2026-10-31T12:00:00Z'));
  });
});

describe('optionalUsernameInput (the signup field)', () => {
  it.each([undefined, '', '   '])('treats %j as not provided, so one is generated', (value) => {
    const parsed = optionalUsernameInput.safeParse(value);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBeUndefined();
  });

  it('normalizes what was typed', () => {
    expect(optionalUsernameInput.parse(' @Ama_Reads ')).toBe('ama_reads');
  });

  it('rejects a malformed or reserved name with a message for the field', () => {
    for (const bad of ['a b', 'admin']) {
      const parsed = optionalUsernameInput.safeParse(bad);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].message).toMatch(/Usernames are|reserved/);
    }
  });
});
