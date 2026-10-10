import { describe, it, expect } from 'vitest';
import { canViewShelf } from '../services/users.service';

describe('canViewShelf', () => {
  it('shows a public shelf to anyone', () => {
    expect(canViewShelf('public', false, false)).toBe(true);
  });

  it('shows a friends-only shelf to accepted followers only', () => {
    expect(canViewShelf('friends', false, true)).toBe(true);
    expect(canViewShelf('friends', false, false)).toBe(false);
  });

  it('hides a private shelf even from accepted followers', () => {
    expect(canViewShelf('private', false, true)).toBe(false);
  });

  it('always shows you your own shelf', () => {
    expect(canViewShelf('private', true, false)).toBe(true);
    expect(canViewShelf('friends', true, false)).toBe(true);
  });
});
