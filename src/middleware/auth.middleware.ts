import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { authService, signAccessToken } from '../services/auth.service';
import { config } from '../config';

export interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    email: string;
  };
}

const REFRESH_THRESHOLD_SECS = 5 * 60; // silently refresh when < 5 min remain

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = authService.verifyAccessToken(token);
    (req as AuthenticatedRequest).user = { id: payload.sub, email: payload.email };

    // Piggyback a fresh access token if the current one is close to expiry.
    // jwt.decode is safe here — we already verified the token above.
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp !== undefined) {
      const secsRemaining = decoded.exp - Math.floor(Date.now() / 1000);
      if (secsRemaining < REFRESH_THRESHOLD_SECS) {
        res.setHeader('X-New-Access-Token', signAccessToken(payload.sub, payload.email));
        res.setHeader('Access-Control-Expose-Headers', 'X-New-Access-Token');
      }
    }

    next();
  } catch (err: unknown) {
    const e = err as Error & { statusCode?: number };
    res.status(e.statusCode ?? 401).json({ error: e.message });
  }
}

/**
 * Like requireAuth, but for routes that stay public for anonymous callers
 * and only add personalized data when a valid token is present. Missing or
 * invalid tokens are treated as "anonymous" rather than a 401 — req.user is
 * simply left unset and the request proceeds. Does not piggyback a refreshed
 * access token, since that's only meaningful for an already-authenticated call.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }

  try {
    const payload = authService.verifyAccessToken(header.slice(7));
    (req as AuthenticatedRequest).user = { id: payload.sub, email: payload.email };
  } catch {
    // Invalid/expired token on an optional-auth route — proceed anonymously
    // rather than failing the request.
  }

  next();
}
