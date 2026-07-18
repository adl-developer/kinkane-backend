/**
 * Drops all server-managed tables, types, triggers, and drizzle migration
 * records so db:init can be run from scratch.
 * WARNING: destroys all data in these tables.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, {
  ssl: process.env.DATABASE_URL!.includes('sslmode=require') ? 'require' : false,
});

async function main() {
  console.log('Dropping triggers and functions...');
  await sql`DROP TRIGGER IF EXISTS trg_book_search_vector ON books`;
  await sql`DROP FUNCTION IF EXISTS update_book_search_vector`;

  console.log('Dropping tables...');
  await sql`DROP TABLE IF EXISTS book_genres, book_contributors, book_subjects, book_prices CASCADE`;
  await sql`DROP TABLE IF EXISTS ingestion_chunks CASCADE`;
  await sql`DROP TABLE IF EXISTS ingestion_jobs CASCADE`;
  await sql`DROP TABLE IF EXISTS recommendation_cache CASCADE`;
  await sql`DROP TABLE IF EXISTS guest_sessions CASCADE`;
  await sql`DROP TABLE IF EXISTS user_books CASCADE`;
  await sql`DROP TABLE IF EXISTS user_interactions CASCADE`;
  await sql`DROP TABLE IF EXISTS user_preferences CASCADE`;
  await sql`DROP TABLE IF EXISTS user_subscriptions CASCADE`;
  await sql`DROP TABLE IF EXISTS books CASCADE`;
  await sql`DROP TABLE IF EXISTS genres CASCADE`;
  await sql`DROP TABLE IF EXISTS user_providers CASCADE`;
  await sql`DROP TABLE IF EXISTS refresh_tokens CASCADE`;
  await sql`DROP TABLE IF EXISTS users CASCADE`;

  console.log('Dropping types...');
  await sql`DROP TYPE IF EXISTS chunk_status`;
  await sql`DROP TYPE IF EXISTS ingestion_status`;
  await sql`DROP TYPE IF EXISTS subscription_status`;
  await sql`DROP TYPE IF EXISTS subscription_tier`;

  console.log('Clearing drizzle migration records...');
  await sql`DELETE FROM drizzle.__drizzle_migrations`;

  console.log('Done. Run npm run db:init to start fresh.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
