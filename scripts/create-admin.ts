/**
 * Creates admin-console accounts, hashing passwords before anything reaches the
 * database.
 *
 *   # one admin, password typed at the prompt (best for a person at a terminal)
 *   npm run admin:create -- --email ama@kinkane.app --name "Ama Boateng"
 *
 *   # one admin, non-interactively (CI, containers, provisioning)
 *   ADMIN_PASSWORD='…' npm run admin:create -- --email ama@kinkane.app --name "Ama"
 *
 *   # several at once, from a file
 *   npm run admin:create -- --file admins.json
 *
 * There is no self-service signup for the console and no password-reset flow, so
 * this script is the only way an account comes into being — and re-running it
 * for an existing email is the reset path.
 *
 * **Plaintext never reaches the database.** Every password is hashed with bcrypt
 * (cost 10) through the same helper the login path verifies against, so a
 * password seeded here and one set later are indistinguishable to the server.
 */
import * as readline from 'node:readline/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { admins } from '../src/db/schema';
import { adminAuthService } from '../src/services/admin/auth.service';
import { config } from '../src/config';

/** Short enough to brute force is short enough to matter, for these accounts. */
const MIN_PASSWORD_LENGTH = 12;

interface AdminSeed {
  email: string;
  name: string;
  password: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/**
 * Refuses to read a seed file that git would happily commit.
 *
 * The file holds plaintext admin passwords. Committing one is the kind of
 * mistake that is invisible until it is in the history forever, and checking is
 * two lines.
 */
function assertNotCommittable(path: string): void {
  const abs = resolve(path);
  let inRepo: string;
  try {
    inRepo = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return; // not a git checkout; nothing to protect against
  }

  const rel = relative(inRepo, abs);
  if (rel.startsWith('..')) return; // outside the repo entirely — fine

  try {
    execSync(`git check-ignore -q ${JSON.stringify(abs)}`, { stdio: 'ignore' });
  } catch {
    fail(
      `Refusing to read "${path}": it sits inside the repository and git does not ignore it.\n` +
        `  It contains plaintext passwords. Either move it outside the repo, or add it to .gitignore.`,
    );
  }
}

function parseSeedFile(path: string): AdminSeed[] {
  if (!existsSync(path)) fail(`No such file: ${path}`);
  assertNotCommittable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) fail(`${path} must contain a JSON array of admins.`);

  return parsed.map((entry, i) => {
    const { email, name, password } = (entry ?? {}) as Partial<AdminSeed>;
    if (!email || !name || !password) {
      fail(`Entry ${i + 1} in ${path} needs "email", "name" and "password".`);
    }
    return { email: email.trim().toLowerCase(), name: name.trim(), password };
  });
}

async function promptPassword(): Promise<string> {
  // Prompting is skipped rather than attempted when stdin is not a terminal:
  // readline never resolves against a pipe, and the process would exit 0 having
  // silently done nothing.
  if (!process.stdin.isTTY) {
    fail(
      'stdin is not a terminal. Use ADMIN_PASSWORD=… for one admin, or --file for several.',
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
  const confirm = await rl.question('Confirm: ');
  rl.close();

  if (password !== confirm) fail('Passwords do not match.');
  return password;
}

/** Upserts one admin. Returns what happened, for the summary. */
async function upsert(seed: AdminSeed): Promise<'created' | 'updated'> {
  if (seed.password.length < MIN_PASSWORD_LENGTH) {
    fail(`Password for ${seed.email} is shorter than ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // Hashed here, before it touches a query. The plaintext never leaves this
  // process and is never written anywhere.
  const passwordHash = await adminAuthService.hashPassword(seed.password);

  const [existing] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(eq(admins.email, seed.email))
    .limit(1);

  if (existing) {
    // Doubles as the password-reset path, and clears a soft-disable so a
    // returning admin does not need a second step.
    await db
      .update(admins)
      .set({ passwordHash, name: seed.name, disabledAt: null, updatedAt: new Date() })
      .where(eq(admins.id, existing.id));
    console.log(`  updated  #${existing.id}  ${seed.email}`);
    return 'updated';
  }

  const [created] = await db
    .insert(admins)
    .values({ email: seed.email, name: seed.name, passwordHash })
    .returning({ id: admins.id });
  console.log(`  created  #${created.id}  ${seed.email}`);
  return 'created';
}

async function main(): Promise<void> {
  if (!config.jwt.adminSecret) {
    console.warn(
      '\n  Warning: ADMIN_JWT_SECRET is not set, so the console will refuse every login\n' +
        '  until it is. Creating the account anyway.\n',
    );
  }

  const file = arg('file');
  const seeds: AdminSeed[] = file
    ? parseSeedFile(file)
    : await (async () => {
        const email = arg('email')?.trim().toLowerCase();
        const name = arg('name')?.trim();
        if (!email || !name) {
          fail(
            'Usage:\n' +
              '    npm run admin:create -- --email <email> --name "<name>"\n' +
              '    npm run admin:create -- --file admins.json',
          );
        }
        return [{ email, name, password: process.env.ADMIN_PASSWORD ?? (await promptPassword()) }];
      })();

  const duplicates = seeds.map((s) => s.email).filter((e, i, all) => all.indexOf(e) !== i);
  if (duplicates.length) fail(`The same email appears twice: ${[...new Set(duplicates)].join(', ')}`);

  console.log('');
  let created = 0;
  let updated = 0;
  for (const seed of seeds) {
    (await upsert(seed)) === 'created' ? created++ : updated++;
  }

  console.log(`\n  ${created} created, ${updated} updated.\n`);
  if (file) {
    console.log(`  Delete ${file} now — it holds plaintext passwords.\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  Failed:', (err as Error).message, '\n');
  process.exit(1);
});
