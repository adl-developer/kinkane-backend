import { describe, it, expect } from 'vitest';
import { canonical } from '../services/preference-history.service';

// `canonical` decides whether a preference save is a real change or a no-op.
// If it's too strict the history fills with duplicate rows; if it's too loose
// real changes go unrecorded.
describe('canonical (preference change detection)', () => {
  it('treats reordered arrays as unchanged', () => {
    expect(canonical(['fantasy', 'crime'])).toBe(canonical(['crime', 'fantasy']));
  });

  it('treats reordered object keys as unchanged', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it('detects an added array element', () => {
    expect(canonical(['crime'])).not.toBe(canonical(['crime', 'fantasy']));
  });

  it('detects a removed array element', () => {
    expect(canonical(['crime', 'fantasy'])).not.toBe(canonical(['crime']));
  });

  it('normalizes nested dislikes objects regardless of ordering', () => {
    const a = { emotionalTone: ['bleak', 'sad'], genreFocus: ['horror'] };
    const b = { genreFocus: ['horror'], emotionalTone: ['sad', 'bleak'] };
    expect(canonical(a)).toBe(canonical(b));
  });

  it('detects a change nested inside dislikes', () => {
    const a = { emotionalTone: ['bleak'] };
    const b = { emotionalTone: ['bleak', 'sad'] };
    expect(canonical(a)).not.toBe(canonical(b));
  });

  it('treats an absent key and an undefined value as the same', () => {
    expect(canonical({ emotionalTone: ['sad'], genreFocus: undefined })).toBe(
      canonical({ emotionalTone: ['sad'] }),
    );
  });

  it('distinguishes null from an empty array', () => {
    expect(canonical(null)).not.toBe(canonical([]));
  });

  it('does not confuse a number with its string form', () => {
    expect(canonical([1, 2])).not.toBe(canonical(['1', '2']));
  });

  it('treats reader type changes as changes', () => {
    expect(canonical('The Seeker')).not.toBe(canonical('The Book-ist'));
    expect(canonical(null)).not.toBe(canonical('The Seeker'));
  });
});
