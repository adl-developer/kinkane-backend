import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

// No lazyConnect — ioredis auto-connects on instantiation.
// lazyConnect:true only defers until the first command, so anything that
// issues a command at import time (e.g. rate-limit-redis store probes)
// would trigger an auto-connect before connectRedis() is called, causing
// "Redis is already connecting/connected" when connect() is called again.
export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error('Redis error', { error: err.message });
});

// Waits for the connection to be ready before the server starts accepting
// traffic. Throws if Redis is not reachable, killing the process on startup.
export async function connectRedis(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
      return;
    }
    redis.once('ready', resolve);
    redis.once('error', reject);
  });
  logger.info('Redis connected');
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis disconnected');
}
