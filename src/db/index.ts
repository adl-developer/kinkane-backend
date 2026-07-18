import * as dotenv from 'dotenv';
dotenv.config();

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

const client = postgres(config.database.url, {
  ssl: config.database.url.includes('sslmode=require') ? 'require' : false,
});

export const db = drizzle(client, { schema });
