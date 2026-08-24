/**
 * Creates (or re-passwords) an admin-console account.
 *
 *   npm run admin:create -- --email ama@kinkane.app --name "Ama Boateng"
 *
 * There is no self-service signup for the console and no password-reset flow,
 * so this script is the only way an account comes into being. It reads the
 * password from stdin rather than taking it as an argument, because arguments
 * end up in shell history and in `ps`.
 */
import * as readline from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { admins } from '../src/db/schema';
import { adminAuthService } from '../src/services/admin/auth.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();

  if (!email || !name) {
    console.error('Usage: npm run admin:create -- --email <email> --name "<name>"');
    process.exit(1);
  }

  // ADMIN_PASSWORD covers non-interactive use — CI, a provisioning script, a
  // container with no TTY. The prompt is the path for a human, and is what
  // keeps the password out of shell history and out of `ps` in the normal case.
  //
  // Prompting is skipped rather than attempted when stdin is not a terminal:
  // readline never resolves against a pipe, and the process would exit 0 having
  // silently done nothing at all.
  let password: string;
  const fromEnv = process.env.ADMIN_PASSWORD;

  if (fromEnv) {
    password = fromEnv;
  } else if (!process.stdin.isTTY) {
    console.error(
      'stdin is not a terminal. Set ADMIN_PASSWORD in the environment to create an admin non-interactively.',
    );
    process.exit(1);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (min 12 chars): ');
    const confirm = await rl.question('Confirm: ');
    rl.close();
    if (password !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }

  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  const passwordHash = await adminAuthService.hashPassword(password);

  const [existing] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email)).limit(1);

  if (existing) {
    // Doubles as the password-reset path: there is no self-service one, and an
    // admin who has forgotten theirs needs someone with shell access anyway.
    await db
      .update(admins)
      .set({ passwordHash, name, disabledAt: null, updatedAt: new Date() })
      .where(eq(admins.id, existing.id));
    console.log(`Updated admin #${existing.id} (${email}).`);
  } else {
    const [created] = await db
      .insert(admins)
      .values({ email, name, passwordHash })
      .returning({ id: admins.id });
    console.log(`Created admin #${created.id} (${email}).`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', (err as Error).message);
  process.exit(1);
});
