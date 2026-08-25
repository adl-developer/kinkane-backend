/**
 * Verifies that this environment's Firebase Admin credentials actually work,
 * without having to deploy and attempt a real social login.
 *
 * Runs three checks, each one further than the last:
 *   1. Which credential source is configured, and whether the private key
 *      parses as PEM at all (this is what fails with the opaque
 *      "DECODER routines::unsupported" when a key is pasted into a dashboard).
 *   2. Whether Google accepts the credential — mints a real access token,
 *      which proves the key, the client email and the clock all line up.
 *   3. Optionally, whether a Firebase ID token verifies end to end. Pass one
 *      as an argument to test the exact path POST /api/v1/auth/social takes.
 *
 * Prints no secret material: keys are reported by length and SHA-256 prefix.
 *
 * Usage: npx tsx scripts/check-firebase.ts [idToken]
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';

// Read before importing config, which exits the process if neither form is set.
const usingBase64 = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64);
const usingLegacy = Boolean(process.env.FIREBASE_PRIVATE_KEY);

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => console.log(`  ✗ ${msg}`);

async function main() {
  console.log('\n1. Credential source\n');

  if (usingBase64) {
    ok(`FIREBASE_SERVICE_ACCOUNT_B64 is set (${process.env.FIREBASE_SERVICE_ACCOUNT_B64!.length} chars)`);
    if (usingLegacy) {
      console.log('  · FIREBASE_PRIVATE_KEY is also set but ignored — the base64 form wins.');
      console.log('    Remove the individual variables to avoid confusion later.');
    }
  } else if (usingLegacy) {
    ok('Using the individual FIREBASE_* variables');
    console.log('  · Prefer FIREBASE_SERVICE_ACCOUNT_B64 in any dashboard-configured');
    console.log('    environment — a pasted PEM key is what breaks on Render.');
  }

  // Importing config resolves and validates the credentials, exiting with its
  // own message if neither form is usable.
  const { config } = await import('../src/config');
  const { projectId, clientEmail, privateKey } = config.firebase;

  console.log(`  · project_id:   ${projectId}`);
  console.log(`  · client_email: ${clientEmail}`);
  console.log(
    `  · private_key:  ${privateKey.length} chars, ` +
      `${(privateKey.match(/\n/g) || []).length} newlines, ` +
      `sha256:${createHash('sha256').update(privateKey).digest('hex').slice(0, 12)}`,
  );

  // The failure this script exists to catch: a key that survived transport
  // with stray quotes or its newlines flattened.
  if (!privateKey.startsWith('-----BEGIN')) {
    bad(`private key starts with ${JSON.stringify(privateKey.slice(0, 12))}, not "-----BEGIN"`);
    console.log('    Stray quotes from a dashboard field are the usual cause.');
    process.exit(1);
  }
  if (!privateKey.trimEnd().endsWith('-----END PRIVATE KEY-----')) {
    bad('private key does not end with the PEM footer — it looks truncated');
    process.exit(1);
  }
  if ((privateKey.match(/\n/g) || []).length < 5) {
    bad('private key has almost no newlines — they were flattened in transport');
    process.exit(1);
  }
  ok('private key looks like well-formed PEM');

  console.log('\n2. Google accepts the credential\n');

  // The PEM checks above catch the malformed-key cases; this is where a key
  // that looks right but isn't actually loadable would throw.
  const { admin } = await import('../src/lib/firebase');
  ok('firebase-admin initialised (private key parsed)');

  const credential = admin.app().options.credential!;
  const token = await credential.getAccessToken();
  ok(`access token minted, expires in ${token.expires_in}s`);
  console.log('    The service account is live and its key is accepted by Google.');

  const idToken = process.argv[2];
  if (!idToken) {
    console.log('\n3. ID token verification — skipped\n');
    console.log('  · Pass a Firebase ID token as an argument to test this:');
    console.log('      npx tsx scripts/check-firebase.ts <idToken>');
    console.log('    Get one in the mobile app after signing in, via');
    console.log('    firebaseUser.getIdToken().');
  } else {
    console.log('\n3. ID token verification\n');
    const decoded = await admin.auth().verifyIdToken(idToken);
    ok(`verified: uid=${decoded.uid} provider=${decoded.firebase.sign_in_provider}`);
  }

  console.log('\nFirebase is configured correctly.\n');
  process.exit(0);
}

main().catch((err: Error) => {
  console.log('');
  bad(err.message);

  // Map the errors that are actually about configuration onto what to do,
  // rather than leaving a raw Google error to be searched for.
  const text = `${err.message} ${(err as { errorInfo?: { message?: string } }).errorInfo?.message ?? ''}`;
  if (text.includes('DECODER routines')) {
    console.log('\n  The private key is not valid PEM. Re-encode the service-account');
    console.log('  JSON and set FIREBASE_SERVICE_ACCOUNT_B64:');
    console.log('    base64 -i serviceAccountKey.json');
  } else if (text.includes('invalid_grant') || text.includes('Invalid JWT')) {
    console.log('\n  The key parsed but Google rejected it. Usually it was revoked');
    console.log('  (generate a new one under Project settings → Service accounts),');
    console.log("  or this machine's clock is skewed.");
  } else if (text.includes('argument-error') || text.includes('id-token')) {
    console.log('\n  The credentials are fine — the ID token argument was rejected.');
    console.log('  Tokens expire after an hour; get a fresh one.');
  }
  console.log('');
  process.exit(1);
});
