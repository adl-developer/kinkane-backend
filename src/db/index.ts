import * as dotenv from 'dotenv';
dotenv.config();

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';
import { resolveSslMode } from './ssl';

const client = postgres(config.database.url, {
  ssl: resolveSslMode(config.database.url),
});

export const db = drizzle(client, { schema });
