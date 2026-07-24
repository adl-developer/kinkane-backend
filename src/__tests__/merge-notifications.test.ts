import { describe, it, expect } from 'vitest';
import { mergeNotifications, type FriendRequestRow } from '../lib/merge-notifications';
import type { Notification } from '../db/schema';

function notif(overrides: Partial<Notification>): Notification {
  return {
    id: 1,
    userId: 1,
    type: 'post_like',
    data: {},
    readAt: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...overrides,
  };
}

function friendReq(overrides: Partial<FriendRequestRow>): FriendRequestRow {
  return {
    id: 1,
    senderId: 2,
    senderName: 'Kwame Asante',
    senderPhotoUrl: null,
    status: 'pending',
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...overrides,
  };
}

describe('mergeNotifications', () => {
  it('interleaves both sources sorted by createdAt descending', () => {
    const notifRows = [
      notif({ id: 1, type: 'post_like', createdAt: new Date('2026-07-23T10:00:00Z') }),
      notif({ id: 2, type: 'post_comment', createdAt: new Date('2026-07-23T08:00:00Z') }),
    ];
    const friendReqRows = [friendReq({ id: 5, createdAt: new Date('2026-07-23T09:00:00Z') })];

    const result = mergeNotifications(notifRows, friendReqRows, 20, 0);

    expect(result.map((r) => r.id)).toEqual([1, 'fr_5', 2]);
  });

  it('prefixes friend-request ids with fr_ and leaves notification ids numeric', () => {
    const result = mergeNotifications([notif({ id: 42 })], [friendReq({ id: 7 })], 20, 0);

    const byType = Object.fromEntries(result.map((r) => [r.type, r.id]));
    expect(byType.post_like).toBe(42);
    expect(byType.friend_request).toBe('fr_7');
  });

  it('maps friend-request rows into the expected data shape with a null readAt', () => {
    const [item] = mergeNotifications(
      [],
      [
        friendReq({
          id: 7,
          senderId: 9,
          senderName: 'Amara Okafor',
          senderPhotoUrl: 'https://cdn.kinkane.app/avatars/9.jpg',
          status: 'pending',
        }),
      ],
      20,
      0,
    );

    expect(item).toMatchObject({
      id: 'fr_7',
      type: 'friend_request',
      readAt: null,
      data: {
        followRequestId: 7,
        senderId: 9,
        senderName: 'Amara Okafor',
        senderPhotoUrl: 'https://cdn.kinkane.app/avatars/9.jpg',
        status: 'pending',
      },
    });
  });

  it('passes through notification data and readAt untouched', () => {
    const readAt = new Date('2026-07-23T09:12:00Z');
    const [item] = mergeNotifications(
      [notif({ id: 3, type: 'post_comment', readAt, data: { postId: 8831, commentPreview: 'Great read' } })],
      [],
      20,
      0,
    );

    expect(item).toMatchObject({
      id: 3,
      type: 'post_comment',
      readAt,
      data: { postId: 8831, commentPreview: 'Great read' },
    });
  });

  it('applies limit and offset across the merged, sorted set', () => {
    const notifRows = [
      notif({ id: 1, createdAt: new Date('2026-07-23T10:00:00Z') }),
      notif({ id: 2, createdAt: new Date('2026-07-23T06:00:00Z') }),
    ];
    const friendReqRows = [
      friendReq({ id: 5, createdAt: new Date('2026-07-23T09:00:00Z') }),
      friendReq({ id: 6, createdAt: new Date('2026-07-23T08:00:00Z') }),
    ];

    // Full sorted order is: notif 1, fr_5, fr_6, notif 2
    const page = mergeNotifications(notifRows, friendReqRows, 2, 1);

    expect(page.map((r) => r.id)).toEqual(['fr_5', 'fr_6']);
  });

  it('returns an empty array when both sources are empty', () => {
    expect(mergeNotifications([], [], 20, 0)).toEqual([]);
  });

  it('returns an empty array when offset is past the end of the merged set', () => {
    const result = mergeNotifications([notif({ id: 1 })], [friendReq({ id: 5 })], 20, 10);
    expect(result).toEqual([]);
  });
});
