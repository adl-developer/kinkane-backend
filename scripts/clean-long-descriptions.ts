/**
 * Strips HTML out of books.long_description, keeping its layout as plain text
 * (paragraphs become blank lines, list items become bullets). See
 * toCleanDescription in src/lib/review-text.ts.
 *
 *   npx tsx scripts/clean-long-descriptions.ts --dry-run
 *   npx tsx scripts/clean-long-descriptions.ts [--limit N] [--after-id N] [--backup FILE]
 *   npx tsx scripts/clean-long-descriptions.ts --restore FILE
 *
 * Only rows with a tag, an HTML entity or the feed's doubled quotes ('') are
 * read, and only rows whose text actually changes are written. Every original
 * is appended to a gzipped JSONL backup *before* its row is updated, so
 * --restore puts the catalogue back exactly as it was. Safe to stop and resume
 * with --after-id (the lastId it prints).
 *
 * updated_at is left alone on purpose: this is a formatting change, not new
 * data from the publisher, so it should not make the nightly jobs treat every
 * cleaned book as changed. Re-run the publisher-reviews backfill with --force
 * afterwards, since the description hashes it compares against change here.
 *
 * Measured on production, 13 Oct 2026: 645,882 descriptions with tags and
 * 149,090 with entities, out of 2.05M books.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import postgres from 'postgres';
import { config } from '../src/config';
import { resolveSslMode } from '../src/db/ssl';
import { toCleanDescription } from '../src/lib/review-text';

const NEEDS_CLEANING = "<[a-zA-Z/!]|&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);|''";
const PAGE_SIZE = 1000;
// Explicit array types (int4[], text[]): without them postgres.js cannot
// serialise an array on a connection's first query, before it has loaded the
// server's types.
const INT4_ARRAY = 1007;
const TEXT_ARRAY = 1009;

const args = process.argv.slice(2);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const limit = argValue('--limit') ? Number(argValue('--limit')) : Number.POSITIVE_INFINITY;
const afterIdArg = Number(argValue('--after-id') ?? 0);
const restoreFile = argValue('--restore');
const backupFile = argValue('--backup') ?? `long-description-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;

const sql = postgres(config.database.url, { ssl: resolveSslMode(config.database.url), max: 1, onnotice: () => {} });

async function applyBatch(ids: number[], descriptions: (string | null)[]): Promise<void> {
  await sql`
    UPDATE books AS b
    SET long_description = u.d
    FROM unnest(${sql.array(ids, INT4_ARRAY)}::int[], ${sql.array(descriptions, TEXT_ARRAY)}::text[]) AS u(id, d)
    WHERE b.id = u.id
  `;
}

/**
 * One backup line per row. U+2028/U+2029 are valid raw inside a JSON string,
 * and some descriptions contain them, but line readers (Node's readline
 * included) treat them as line breaks; escaping them keeps one row per line
 * for any reader.
 */
function backupLine(id: number, longDescription: string): string {
  return JSON.stringify({ id, long_description: longDescription }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Splits on '\n' only, for the same reason — and so older backups with raw separators still restore. */
async function* backupRows(file: string): AsyncGenerator<{ id: number; long_description: string | null }> {
  const stream = createReadStream(file).pipe(createGunzip());
  stream.setEncoding('utf8');
  let pending = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) yield JSON.parse(line);
  }
  if (pending) yield JSON.parse(pending);
}

async function restore(file: string): Promise<void> {
  let ids: number[] = [];
  let descriptions: (string | null)[] = [];
  let restored = 0;
  for await (const row of backupRows(file)) {
    ids.push(row.id);
    descriptions.push(row.long_description);
    if (ids.length === PAGE_SIZE) {
      await applyBatch(ids, descriptions);
      restored += ids.length;
      ids = [];
      descriptions = [];
    }
  }
  if (ids.length) await applyBatch(ids, descriptions);
  console.log({ restored: restored + ids.length });
}

async function clean(): Promise<void> {
  const gzip = dryRun ? null : createGzip();
  const finished = gzip ? new Promise<void>((resolve, reject) => {
    const out = createWriteStream(backupFile);
    gzip.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  }) : Promise.resolve();
  const backup = (chunk: string) => new Promise<void>((resolve, reject) => gzip!.write(chunk, (err) => (err ? reject(err) : resolve())));

  // Ctrl-C finishes the batch in flight and closes the backup properly; a
  // second Ctrl-C exits at once. Killing it mid-write would leave a gzip file
  // without its trailer, which --restore cannot read to the end.
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('Stopping after this batch… (Ctrl-C again to quit now)');
  });

  const started = Date.now();
  let lastLog = 0;
  let afterId = afterIdArg;
  const stats = { read: 0, changed: 0, emptied: 0, lastId: afterId };
  const samples: { id: number; before: string; after: string | null }[] = [];

  while (stats.read < limit && !stopping) {
    const rows = await sql<{ id: number; long_description: string }[]>`
      SELECT id, long_description FROM books
      WHERE id > ${afterId} AND long_description ~ ${NEEDS_CLEANING}
      ORDER BY id
      LIMIT ${Math.min(PAGE_SIZE, limit - stats.read)}
    `;
    if (rows.length === 0) break;

    const changes = rows
      .map((r) => ({ id: r.id, before: r.long_description, after: toCleanDescription(r.long_description) || null }))
      .filter((c) => c.after !== c.before);

    if (dryRun) {
      if (samples.length < 5) samples.push(...changes.slice(0, 5 - samples.length));
    } else if (changes.length) {
      // Originals first: a row is only overwritten once its old text is in the backup.
      await backup(changes.map((c) => backupLine(c.id, c.before)).join('\n') + '\n');
      await applyBatch(changes.map((c) => c.id), changes.map((c) => c.after));
    }

    stats.read += rows.length;
    stats.changed += changes.length;
    stats.emptied += changes.filter((c) => c.after === null).length;
    afterId = rows[rows.length - 1].id;
    stats.lastId = afterId;
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      console.log(`${((Date.now() - started) / 60_000).toFixed(1)} min`, stats);
    }
  }

  gzip?.end();
  await finished;
  if (dryRun) {
    for (const s of samples) {
      console.log(`\n── #${s.id} before ──\n${s.before.slice(0, 400)}\n── after ──\n${(s.after ?? '(empty → NULL)').slice(0, 400)}`);
    }
  }
  console.log({ ...stats, dryRun, backup: dryRun ? null : backupFile, minutes: ((Date.now() - started) / 60_000).toFixed(1) });
}

(restoreFile ? restore(restoreFile) : clean())
  .then(async () => {
    await sql.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await sql.end().catch(() => undefined);
    process.exit(1);
  });
