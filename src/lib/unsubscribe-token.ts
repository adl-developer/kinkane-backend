import jwt from 'jsonwebtoken';
import { config } from '../config';

const PURPOSE = 'email-unsubscribe';

/**
 * Generates a signed, non-expiring token for a user's one-click unsubscribe link.
 * The token encodes the user's email address — safe to include since the
 * recipient already knows their own address, and the signature prevents
 * anyone from forging a token for a different address.
 * Non-expiring because unsubscribe links in old emails must keep working.
 */
export function generateUnsubscribeToken(email: string): string {
  return jwt.sign({ sub: email, purpose: PURPOSE }, config.unsubscribeSecret, {
    algorithm: 'HS256',
  });
}

/**
 * Verifies the token and returns the email address, or throws if invalid/tampered.
 */
export function verifyUnsubscribeToken(token: string): string {
  const payload = jwt.verify(token, config.unsubscribeSecret, {
    algorithms: ['HS256'],
  }) as unknown as { sub: string; purpose: string };

  if (payload.purpose !== PURPOSE) {
    throw new Error('Invalid token purpose');
  }

  return payload.sub;
}

/**
 * Returns the full unsubscribe URL to embed in an email footer.
 * Pass the recipient's email address — it is already known to them.
 */
export function unsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  return `${config.appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}
