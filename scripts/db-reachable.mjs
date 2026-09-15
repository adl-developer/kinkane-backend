// Exits 0 if DATABASE_URL accepts a connection, 1 otherwise.
//
// Used by the pre-commit hook to tell two very different situations apart: the
// endpoint contract suite failing because something is genuinely broken, and it
// failing because Postgres simply is not running on this machine right now. The
// first must block a commit; the second must not, or the hook gets disabled.
import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) process.exit(1);

const sql = postgres(url, { connect_timeout: 3, max: 1, onnotice: () => {} });

try {
  await sql`SELECT 1`;
  await sql.end({ timeout: 1 });
  process.exit(0);
} catch {
  process.exit(1);
}
