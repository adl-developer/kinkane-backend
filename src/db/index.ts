import * as dotenv from 'dotenv';
dotenv.config();

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';
import { resolveSslMode } from './ssl';
import { onNotice } from './notices';

const client = postgres(config.database.url, {
  ssl: resolveSslMode(config.database.url),
  onnotice: onNotice,
  // Sent as a startup parameter, so every pooled connection carries it. SET LOCAL still
  // overrides it per transaction (see withStatementTimeout in books.service.ts).
  connection: { statement_timeout: config.database.statementTimeoutMs },
});

export const db = drizzle(client, { schema });

/** The handle passed to a `db.transaction` callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
