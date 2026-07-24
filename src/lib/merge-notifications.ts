import type { Notification } from '../db/schema';

export interface FriendRequestRow {
  id: number;
  senderId: number;
  senderName: string;
  senderPhotoUrl: string | null;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: Date;
}

export type NotificationItem =
  | {
      id: number;
      type: 'post_like' | 'post_comment';
      createdAt: Date;
      readAt: Date | null;
      data: Record<string, unknown>;
    }
  | {
      id: string;
      type: 'friend_request';
      createdAt: Date;
      readAt: null;
      data: {
        followRequestId: number;
        senderId: number;
        senderName: string;
        senderPhotoUrl: string | null;
        status: 'pending' | 'accepted' | 'declined';
      };
    };

// Merges persisted notification rows with the live friend-request view into a
// single feed sorted by createdAt descending, then slices to the requested
// page. Kept pure/DB-free so it can be unit tested against hand-built rows —
// the two sources are fetched independently since they don't share a schema
// to UNION in SQL.
export function mergeNotifications(
  notifRows: Notification[],
  friendReqRows: FriendRequestRow[],
  limit: number,
  offset: number,
): NotificationItem[] {
  const merged: NotificationItem[] = [
    ...notifRows.map(
      (row): NotificationItem => ({
        id: row.id,
        type: row.type as 'post_like' | 'post_comment',
        createdAt: row.createdAt,
        readAt: row.readAt,
        data: row.data as Record<string, unknown>,
      }),
    ),
    ...friendReqRows.map(
      (row): NotificationItem => ({
        id: `fr_${row.id}`,
        type: 'friend_request',
        createdAt: row.createdAt,
        readAt: null,
        data: {
          followRequestId: row.id,
          senderId: row.senderId,
          senderName: row.senderName,
          senderPhotoUrl: row.senderPhotoUrl,
          status: row.status,
        },
      }),
    ),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return merged.slice(offset, offset + limit);
}
