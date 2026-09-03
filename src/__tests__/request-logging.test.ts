import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Capture everything the logger writes to stdout/stderr as parsed JSON lines.
function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const push = (chunk: unknown) => {
    for (const raw of String(chunk).split('\n')) {
      if (raw.trim()) lines.push(JSON.parse(raw));
    }
    return true;
  };
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(push as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(push as never);
  return { lines, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

describe('logger level filtering', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('suppresses debug when NODE_ENV=production and no LOG_LEVEL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', undefined as unknown as string);
    const { logger } = await import('../lib/logger');
    const { lines, restore } = captureLogs();
    logger.debug('nope');
    logger.info('yes');
    restore();
    expect(lines.map((l) => l.message)).toEqual(['yes']);
  });

  it('LOG_LEVEL=error silences everything below error', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', 'error');
    const { logger } = await import('../lib/logger');
    const { lines, restore } = captureLogs();
    logger.info('x'); logger.warn('y'); logger.error('z');
    restore();
    expect(lines.map((l) => l.message)).toEqual(['z']);
  });

  it('threads runWithLogContext into every line emitted inside it', async () => {
    const { logger, runWithLogContext } = await import('../lib/logger');
    const { lines, restore } = captureLogs();
    runWithLogContext({ requestId: 'ctx-1' }, () => logger.error('inside'));
    logger.error('outside');
    restore();
    const inside = lines.find((l) => l.message === 'inside');
    const outside = lines.find((l) => l.message === 'outside');
    expect(inside?.requestId).toBe('ctx-1');
    expect(outside?.requestId).toBeUndefined();
  });
});

describe('request logger middleware', () => {
  async function withServer(
    build: (app: express.Express) => void,
    run: (base: string) => Promise<void>,
  ) {
    const { requestLogger } = await import('../middleware/request-logger.middleware');
    const app = express();
    app.use(requestLogger);
    build(app);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://localhost:${port}`);
    } finally {
      server.close();
    }
  }

  it('sets X-Request-Id and logs a summary line with route template', async () => {
    await withServer(
      (app) => app.get('/books/:id', (_req, res) => res.json({ ok: true })),
      async (base) => {
        const { lines, restore } = captureLogs();
        const res = await fetch(`${base}/books/42`);
        restore();
        expect(res.headers.get('x-request-id')).toBeTruthy();
        const summary = lines.find((l) => l.message === 'request');
        expect(summary).toMatchObject({ method: 'GET', path: '/books/:id', status: 200 });
        expect(summary?.durationMs).toEqual(expect.any(Number));
      },
    );
  });

  it('honours and echoes a well-formed inbound x-request-id', async () => {
    await withServer(
      (app) => app.get('/x', (_req, res) => res.end()),
      async (base) => {
        const res = await fetch(`${base}/x`, { headers: { 'x-request-id': 'abc-123' } });
        expect(res.headers.get('x-request-id')).toBe('abc-123');
      },
    );
  });

  it('rejects a malformed inbound id and mints its own', async () => {
    await withServer(
      (app) => app.get('/x', (_req, res) => res.end()),
      async (base) => {
        const res = await fetch(`${base}/x`, { headers: { 'x-request-id': 'bad id with spaces' } });
        const id = res.headers.get('x-request-id');
        expect(id).not.toBe('bad id with spaces');
        expect(id).toMatch(/^[\w-]+$/);
      },
    );
  });

  it('logs 4xx at warn and 5xx at error', async () => {
    await withServer(
      (app) => {
        app.get('/missing', (_req, res) => res.status(404).end());
        app.get('/boom', () => { throw new Error('kaboom'); });
      },
      async (base) => {
        const { lines, restore } = captureLogs();
        await fetch(`${base}/missing`);
        await fetch(`${base}/boom`);
        restore();
        const summaries = lines.filter((l) => l.message === 'request');
        expect(summaries.find((l) => l.status === 404)?.level).toBe('warn');
        expect(summaries.find((l) => l.status === 500)?.level).toBe('error');
      },
    );
  });
});
