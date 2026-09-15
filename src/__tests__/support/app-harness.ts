import type { Server } from 'node:http';

/**
 * Binds the real Express app to an ephemeral port for the duration of a suite.
 *
 * Port 0 rather than the configured one: the dev server is usually already on
 * 3000, and a suite that fails with EADDRINUSE depending on what the developer
 * happens to have running is a suite people learn to ignore.
 *
 * The whole app is used — helmet, CORS, the rate limiters, the error handler —
 * because the bugs worth catching here live in the wiring. A handler tested in
 * isolation cannot tell you that a route was never mounted, that middleware
 * rejects it before it runs, or that the error handler turns a thrown database
 * error into a 500.
 */
export interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startApp(): Promise<Harness> {
  const { default: app } = await import('../../app');

  return new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an ephemeral TCP port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on('error', reject);
  });
}
