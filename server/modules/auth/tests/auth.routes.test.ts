import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';
import type { createAuthService } from '../auth.service.js';

type AuthService = ReturnType<typeof createAuthService>;

async function withAuthServer(
  login: AuthService['login'],
  run: (post: (password: string) => Promise<globalThis.Response>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ login } as AuthService, (_req, _res, next) => next()));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const appError = err as AppError;
    res.status(appError.statusCode ?? 500).json({ error: { code: appError.code, message: appError.message } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    await run((password) => fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    }));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const invalidCredentials = () => new AppError('Invalid username or password', {
  code: 'AUTH_INVALID_CREDENTIALS',
  statusCode: 401,
});

test('login locks the client out after five failed attempts, even with the right password', async () => {
  let loginCalls = 0;
  await withAuthServer(async (_username, password) => {
    loginCalls += 1;
    if (password !== 'correct') throw invalidCredentials();
    return { success: true, user: { id: 1, username: 'admin' }, token: 'token' };
  }, async (post) => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await post('wrong')).status, 401);
    }

    const locked = await post('correct');
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    const body = await locked.json() as { error: { code: string } };
    assert.equal(body.error.code, 'AUTH_TOO_MANY_ATTEMPTS');
    assert.equal(loginCalls, 5);
  });
});

test('successful login resets the failed attempt counter', async () => {
  await withAuthServer(async (_username, password) => {
    if (password !== 'correct') throw invalidCredentials();
    return { success: true, user: { id: 1, username: 'admin' }, token: 'token' };
  }, async (post) => {
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await post('wrong')).status, 401);
    }
    assert.equal((await post('correct')).status, 200);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await post('wrong')).status, 401);
    }
    assert.equal((await post('correct')).status, 200);
  });
});
