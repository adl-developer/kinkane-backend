import app from './app';
import { config } from './config';
import { logger } from './lib/logger';

async function main(): Promise<void> {
  const server = app.listen(config.port, () => {
    logger.info('kinkane-server started', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down gracefully', { signal });
    server.close(() => logger.info('HTTP server closed'));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
