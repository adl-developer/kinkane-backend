import { describe, it, expect } from 'vitest';
import { decideFollowRequest, type FollowRequestDecision } from '../services/users.service';

// Pins what POST /users/:userId/follow does for every combination of the
// caller's own request and the other person's request back. The one that
// matters most is a pending request coming the other way: without that check
// two people each end up waiting on the other for the same relationship.

const row = (status: 'pending' | 'accepted' | 'declined', id = 1) => ({ id, status });
const decide = (
  outgoing: ReturnType<typeof row> | undefined,
  incoming: ReturnType<typeof row> | undefined,
): FollowRequestDecision => decideFollowRequest(outgoing, incoming, 'Ama Boateng');

describe('a pending request from the other person', () => {
  it('refuses with a 409 that names them and says what to do instead', () => {
    const d = decide(undefined, row('pending', 902));
    expect(d.action).toBe('reject');
    if (d.action !== 'reject') return;
    expect(d.statusCode).toBe(409);
    expect(d.message).toBe('Ama Boateng has already sent you a follow request. Accept or decline it instead.');
  });

  it('carries a code and their request id so the app can accept in one tap', () => {
    const d = decide(undefined, row('pending', 902));
    expect(d).toMatchObject({
      code: 'INCOMING_FOLLOW_REQUEST_PENDING',
      details: { requestId: 902 },
    });
  });

  it('also blocks re-sending a request the other person had declined', () => {
    // The caller's own declined request would normally be reset to pending,
    // but their pending request to the caller still needs answering first.
    expect(decide(row('declined'), row('pending', 902))).toMatchObject({
      action: 'reject',
      code: 'INCOMING_FOLLOW_REQUEST_PENDING',
    });
  });
});

describe('the caller\'s own request is answered first', () => {
  it('reports "already sent" over a crossing request from the other side', () => {
    // Crossed pending requests can exist from before this check. Telling the
    // caller about their own request is the answer that matches what they did.
    const d = decide(row('pending'), row('pending', 902));
    expect(d).toMatchObject({ action: 'reject', message: 'Follow request already sent' });
    expect(d).not.toHaveProperty('code');
  });

  it('reports "already following" whatever the other side looks like', () => {
    for (const incoming of [undefined, row('pending'), row('accepted'), row('declined')]) {
      expect(decide(row('accepted'), incoming)).toMatchObject({
        action: 'reject',
        message: 'You are already following this user',
      });
    }
  });
});

describe('an incoming request that is no longer pending does not block', () => {
  it('lets you follow back someone who already follows you', () => {
    // Follows go one way. Their accepted request means they follow you;
    // following them is a separate relationship.
    expect(decide(undefined, row('accepted'))).toEqual({ action: 'insert' });
  });

  it('lets you follow someone whose request you declined', () => {
    expect(decide(undefined, row('declined'))).toEqual({ action: 'insert' });
  });
});

describe('with nothing in the way', () => {
  it('inserts a new request when neither side has one', () => {
    expect(decide(undefined, undefined)).toEqual({ action: 'insert' });
  });

  it('re-sends the caller\'s declined request rather than inserting a duplicate', () => {
    expect(decide(row('declined', 55), undefined)).toEqual({ action: 'resend', requestId: 55 });
  });
});
