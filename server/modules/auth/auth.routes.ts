import express from 'express';
import type { RequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
type LoginAttempts = Map<string, { count: number; resetAt: number }>;

function beginLoginAttempt(loginAttempts: LoginAttempts, clientKey: string) {
  const now = Date.now();
  if (loginAttempts.size > 1000) {
    for (const [key, entry] of loginAttempts) {
      if (now >= entry.resetAt) loginAttempts.delete(key);
    }
  }
  let attempt = loginAttempts.get(clientKey);
  if (!attempt || now >= attempt.resetAt) {
    attempt = { count: 0, resetAt: now + LOGIN_LOCKOUT_MS };
    loginAttempts.set(clientKey, attempt);
  }
  if (attempt.count >= MAX_FAILED_LOGINS) {
    const retryAfterSeconds = Math.ceil((attempt.resetAt - now) / 1000);
    throw new AppError(
      `Too many failed login attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      { code: 'AUTH_TOO_MANY_ATTEMPTS', statusCode: 429, details: { retryAfterSeconds } },
    );
  }
  // Counted before password verification so parallel requests cannot bypass the limit.
  attempt.count += 1;
  return attempt;
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();
  const loginAttempts: LoginAttempts = new Map();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    const clientKey = req.socket.remoteAddress || 'unknown';
    try {
      const attempt = beginLoginAttempt(loginAttempts, clientKey);
      const body = req.body as { username?: unknown; password?: unknown; code?: unknown };
      try {
        res.json(await service.login(body.username, body.password, body.code));
        loginAttempts.delete(clientKey);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS')) {
          attempt.count -= 1;
        } else if (attempt.count >= MAX_FAILED_LOGINS) {
          attempt.resetAt = Date.now() + LOGIN_LOCKOUT_MS;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_TOO_MANY_ATTEMPTS') {
        res.setHeader('Retry-After', String((error.details as { retryAfterSeconds: number }).retryAfterSeconds));
      }
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
