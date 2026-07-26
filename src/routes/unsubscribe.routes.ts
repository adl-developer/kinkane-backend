import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema/users';
import { notificationPreferences } from '../db/schema/notification-preferences';
import { verifyUnsubscribeToken } from '../lib/unsubscribe-token';
import { logger } from '../lib/logger';

const router = Router();

const successHtml = (message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kinkané — ${message}</title>
  <style>
    body { margin: 0; padding: 0; background: #EEECE6; font-family: Georgia, 'Times New Roman', serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; max-width: 480px; width: 90%; padding: 48px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .logo { font-size: 18px; font-weight: bold; color: #1A1A1A; margin-bottom: 32px; }
    .logo span { display: inline-block; background: #1A1A1A; color: #fff; border-radius: 5px; padding: 3px 7px; margin-right: 6px; font-size: 12px; font-family: Arial, sans-serif; }
    h1 { font-size: 22px; color: #1A1A1A; margin: 0 0 16px; line-height: 1.3; }
    p { font-size: 14px; color: #666; line-height: 1.7; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span>K</span>Kinkané</div>
    <h1>${message}</h1>
    <p>You won't receive marketing or notification emails from Kinkané.<br/>Security emails (password resets, verification codes) will still be sent.</p>
  </div>
</body>
</html>`;

const errorHtml = (message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kinkané — Unsubscribe</title>
  <style>
    body { margin: 0; padding: 0; background: #EEECE6; font-family: Georgia, 'Times New Roman', serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; max-width: 480px; width: 90%; padding: 48px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .logo { font-size: 18px; font-weight: bold; color: #1A1A1A; margin-bottom: 32px; }
    .logo span { display: inline-block; background: #1A1A1A; color: #fff; border-radius: 5px; padding: 3px 7px; margin-right: 6px; font-size: 12px; font-family: Arial, sans-serif; }
    h1 { font-size: 22px; color: #1A1A1A; margin: 0 0 16px; line-height: 1.3; }
    p { font-size: 14px; color: #666; line-height: 1.7; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><span>K</span>Kinkané</div>
    <h1>Link not valid</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

/**
 * GET /api/v1/unsubscribe?token=<signed-jwt>
 *
 * One-click unsubscribe. Verifies the HMAC-signed token, then sets all
 * notification preference flags to false for that user. No authentication
 * required — the signed token is the proof of identity.
 *
 * Security emails (password reset, OTP, account alerts) are never gated on
 * notification preferences and continue to send regardless.
 *
 * Returns an HTML page (not JSON) — this URL is opened in a browser from
 * the email client, not called by the app.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    res.status(400).send(errorHtml('This unsubscribe link is missing or incomplete. Please use the link from your email.'));
    return;
  }

  let email: string;
  try {
    email = verifyUnsubscribeToken(token);
  } catch {
    res.status(400).send(errorHtml('This unsubscribe link has expired or is invalid. Please use the link from a recent email.'));
    return;
  }

  try {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      res.status(200).send(successHtml("You've been unsubscribed"));
      return;
    }

    const result = await db
      .update(notificationPreferences)
      .set({
        newBookSuggestions: false,
        rateReviewReminders: false,
        friendRequests: false,
        updatedAt: new Date(),
      })
      .where(eq(notificationPreferences.userId, user.id))
      .returning({ id: notificationPreferences.id });

    if (result.length === 0) {
      logger.warn('Unsubscribe: no notification_preferences row found', { email });
    } else {
      logger.info('User unsubscribed from all emails', { email });
    }

    res.status(200).send(successHtml("You've been unsubscribed"));
  } catch (err) {
    logger.error('Failed to process unsubscribe', { email, error: (err as Error).message });
    res.status(500).send(errorHtml('Something went wrong. Please try again or contact support.'));
  }
});

export default router;
