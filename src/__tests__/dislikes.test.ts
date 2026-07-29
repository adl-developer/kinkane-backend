import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildPreferenceText } from '../services/recommendations.service';

// The dislikes payload is deliberately open — the onboarding UI owns both the
// category keys and the labels. These tests pin the contract that lets the
// frontend add or reword a category without a backend release.
const dislikesSchema = z.record(
  z.string().min(1).max(100),
  z.array(z.string().min(1).max(200)),
);

describe('dislikes validation (open shape)', () => {
  it('accepts category keys the backend has never seen', () => {
    const parsed = dislikesSchema.parse({
      emotionalTone: ['too dark or heavy'],
      contentSensitivity: ['graphic violence', 'explicit content'],
      somethingAddedNextQuarter: ['a brand new label'],
    });
    expect(Object.keys(parsed)).toContain('contentSensitivity');
    expect(Object.keys(parsed)).toContain('somethingAddedNextQuarter');
  });

  it('accepts labels outside the old preset lists', () => {
    expect(dislikesSchema.safeParse({ emotionalTone: ['bleak endings'] }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(dislikesSchema.parse({})).toEqual({});
  });

  it('still rejects a non-array value', () => {
    expect(dislikesSchema.safeParse({ emotionalTone: 'too dark' }).success).toBe(false);
  });

  // Every label lands in the embedded preference text, so length stays capped.
  it('still rejects a label over 200 characters', () => {
    expect(dislikesSchema.safeParse({ emotionalTone: ['x'.repeat(201)] }).success).toBe(false);
  });
});

describe('buildPreferenceText with open dislikes', () => {
  it('includes labels from every category, known or not', () => {
    const text = buildPreferenceText(
      {
        feelings: ['calm'],
        genres: ['poetry'],
        dislikes: {
          contentSensitivity: ['graphic violence'],
          madeUpCategory: ['some other thing'],
        },
      },
      [],
    );
    expect(text).toContain('graphic violence');
    expect(text).toContain('some other thing');
  });

  it('omits the avoid clause when there is nothing to avoid', () => {
    const text = buildPreferenceText(
      { feelings: ['calm'], genres: ['poetry'], dislikes: { emotionalTone: [] } },
      [],
    );
    expect(text).not.toContain('I want to avoid');
  });
});
