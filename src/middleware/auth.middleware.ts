import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

export interface AuthenticatedRequest extends Request {
  user: {
    id: number;
    email: string;
  };
}

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
    next();
  } catch (err: unknown) {
    const e = err as Error & { statusCode?: number };
    res.status(e.statusCode ?? 401).json({ error: e.message });
  }
}
