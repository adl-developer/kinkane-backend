/**
 * Installs required PostgreSQL extensions before running migrations.
 * Must run once before the first `drizzle-kit migrate`.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, {
  ssl: process.env.NODE_ENV === 'production' ? 'require' : false,
});

async function main() {
  console.log('Installing PostgreSQL extensions...');
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  console.log('Extensions installed.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
