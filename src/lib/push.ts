import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceTokens } from '../db/schema';
import { admin } from './firebase';
import { logger } from './logger';

const STALE_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendPush(userId: number, payload: PushPayload): Promise<void> {
  if (!admin.apps.length) {
    logger.warn('Skipped push — Firebase not initialized', { userId });
    return;
  }

  const rows = await db
    .select({ fcmToken: deviceTokens.fcmToken })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId));

  if (rows.length === 0) return;

  const tokens = rows.map((r) => r.fcmToken);

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data ?? {},
  });

  if (response.failureCount === 0) return;

  const staleTokens: string[] = [];
  response.responses.forEach((res, i) => {
    if (res.success) return;
    const code = res.error?.code;
    if (code && STALE_TOKEN_ERROR_CODES.has(code)) {
      staleTokens.push(tokens[i]);
    } else {
      logger.warn('Push send failed for token', { userId, code, message: res.error?.message });
    }
  });

  if (staleTokens.length > 0) {
    await db.delete(deviceTokens).where(inArray(deviceTokens.fcmToken, staleTokens));
  }
}
