import { describe, it, expect } from 'vitest';
import { decideFollowRequest } from '../services/users.service';

// Pins what POST /users/:userId/follow does for each state of the caller's own
// request. Follows go one way, so a request coming the other way — even a
// pending one — is a separate relationship and is not an input here at all.

const row = (status: 'pending' | 'accepted' | 'declined', id = 1) => ({ id, status });

describe('the caller\'s own request', () => {
  it('refuses a second request while the first is still pending', () => {
    expect(decideFollowRequest(row('pending'))).toEqual({
      action: 'reject',
      message: 'Follow request already sent',
    });
  });

  it('refuses when the caller already follows them', () => {
    expect(decideFollowRequest(row('accepted'))).toEqual({
      action: 'reject',
      message: 'You are already following this user',
    });
  });

  it('re-sends a declined request rather than inserting a duplicate', () => {
    expect(decideFollowRequest(row('declined', 55))).toEqual({ action: 'resend', requestId: 55 });
  });

  it('inserts a new request when there is none', () => {
    expect(decideFollowRequest(undefined)).toEqual({ action: 'insert' });
  });
});
