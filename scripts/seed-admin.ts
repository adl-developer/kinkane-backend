/**
 * Runs just the admin-account seed from src/db/seeds/admins.ts, without the
 * migrations and index builds `npm run db:init` does around it.
 *
 *   DEVELOPER_ADMIN_SEED_PASSWORD='…' npm run seed:admin
 *
 * Deploys don't need this — db:init already runs the same seed.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';
import { resolveSslMode } from '../src/db/ssl';
import { seedAdmin, SEEDED_ADMIN_EMAIL } from '../src/db/seeds/admins';

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { ssl: resolveSslMode(process.env.DATABASE_URL!) });
  const result = await seedAdmin(sql);
  await sql.end();

  if (result === 'skipped') {
    console.error('\n  DEVELOPER_ADMIN_SEED_PASSWORD is not set — nothing seeded.\n');
    process.exit(1);
  }
  console.log(`\n  ${SEEDED_ADMIN_EMAIL}: ${result === 'created' ? 'created' : 'already exists, left unchanged'}\n`);
}

main().catch((err) => {
  console.error('\n  Failed:', (err as Error).message, '\n');
  process.exit(1);
});
