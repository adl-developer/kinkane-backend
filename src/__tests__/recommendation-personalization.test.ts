import { describe, it, expect } from 'vitest';
import {
  personalizeExplanations,
  toFirstName,
} from '../services/recommendations.service';
import { NAME_PLACEHOLDER } from '../lib/gemini';

// The reader's name never enters the recommendation cache: a result set is
// shared by everyone whose quiz answers hash the same way, so the cached text
// carries a token and the name is applied per reader on the way out. These
// tests pin that contract — the failure mode they exist to prevent is one
// reader being greeted by another reader's name.

function item(explanation: string) {
  return { bookId: 1, rank: 1, explanation };
}

describe('toFirstName', () => {
  it('addresses a reader by their first name only', () => {
    expect(toFirstName('Elisabeth Mensah')).toBe('Elisabeth');
  });

  it('handles a single-word name', () => {
    expect(toFirstName('Elisabeth')).toBe('Elisabeth');
  });

  it('ignores surrounding and repeated whitespace', () => {
    expect(toFirstName('  Elisabeth   Mensah ')).toBe('Elisabeth');
  });

  it('returns empty for a missing name rather than throwing', () => {
    expect(toFirstName(null)).toBe('');
    expect(toFirstName(undefined)).toBe('');
    expect(toFirstName('   ')).toBe('');
  });

  it('caps an absurdly long first name so it cannot eat the card', () => {
    expect(toFirstName('E'.repeat(200))).toHaveLength(40);
  });
});

describe('personalizeExplanations', () => {
  it('puts the reader name where the token is', () => {
    const [out] = personalizeExplanations(
      [item(`${NAME_PLACEHOLDER}, you wanted something meaningful, but not heavy.`)],
      'Elisabeth',
    );
    expect(out.explanation).toBe(
      'Elisabeth, you wanted something meaningful, but not heavy.',
    );
  });

  it('replaces the token wherever it sits in the sentence', () => {
    const [out] = personalizeExplanations(
      [item(`This moves gently, ${NAME_PLACEHOLDER}, but still challenges you.`)],
      'Elisabeth Mensah',
    );
    expect(out.explanation).toBe('This moves gently, Elisabeth, but still challenges you.');
  });

  it('gives two readers with the same cached text their own name', () => {
    const cached = [item(`${NAME_PLACEHOLDER}, this one is for you.`)];

    const [first] = personalizeExplanations(cached, 'Elisabeth');
    const [second] = personalizeExplanations(cached, 'Kwame');

    expect(first.explanation).toBe('Elisabeth, this one is for you.');
    expect(second.explanation).toBe('Kwame, this one is for you.');
  });

  it('does not mutate the cached items it was handed', () => {
    const cached = [item(`${NAME_PLACEHOLDER}, this one is for you.`)];
    personalizeExplanations(cached, 'Elisabeth');
    expect(cached[0].explanation).toContain(NAME_PLACEHOLDER);
  });

  it('leaves bookId and rank untouched', () => {
    const [out] = personalizeExplanations(
      [{ bookId: 42, rank: 7, explanation: `${NAME_PLACEHOLDER}, read this.` }],
      'Elisabeth',
    );
    expect(out).toMatchObject({ bookId: 42, rank: 7 });
  });

  it('never leaves a raw token visible when there is no name', () => {
    const [out] = personalizeExplanations(
      [item(`${NAME_PLACEHOLDER}, you wanted something meaningful.`)],
      null,
    );
    expect(out.explanation).not.toContain(NAME_PLACEHOLDER);
    expect(out.explanation).toBe('You wanted something meaningful.');
  });

  it('strips a mid-sentence token cleanly when there is no name', () => {
    const [out] = personalizeExplanations(
      [item(`This moves gently, ${NAME_PLACEHOLDER}, and still challenges you.`)],
      '',
    );
    expect(out.explanation).not.toContain(NAME_PLACEHOLDER);
    expect(out.explanation).toBe('This moves gently, and still challenges you.');
  });

  it('passes through an explanation the model wrote without a token', () => {
    const [out] = personalizeExplanations([item('A quiet, hopeful read.')], 'Elisabeth');
    expect(out.explanation).toBe('A quiet, hopeful read.');
  });

  it('passes through an empty explanation from a failed Gemini chunk', () => {
    const [out] = personalizeExplanations([item('')], 'Elisabeth');
    expect(out.explanation).toBe('');
  });
});
