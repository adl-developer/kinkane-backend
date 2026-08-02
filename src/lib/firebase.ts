import admin from 'firebase-admin';
import { config } from '../config';

if (!admin.apps.length) {
  // Credentials are resolved and shape-checked in src/config — newline
  // unescaping included — so all that can fail here is the private key itself
  // being unparseable, which config can't detect without trying it.
  //
  // This used to warn and continue. It now throws: Firebase backs Google
  // sign-in and push notifications, and a server that boots without it looks
  // healthy to Render's health check while rejecting every social login.
  try {
    admin.initializeApp({
      credential: admin.credential.cert(config.firebase),
    });
  } catch (err) {
    throw new Error(
      `[firebase] Could not initialise Firebase Admin: ${(err as Error).message}\n` +
        'A "DECODER routines::unsupported" message here means the private key is not valid PEM — ' +
        'usually stray quotes or flattened newlines from pasting it into a dashboard field. ' +
        'Prefer FIREBASE_SERVICE_ACCOUNT_B64 (base64 -i serviceAccountKey.json), which has no ' +
        'characters a web form can mangle.',
      { cause: err },
    );
  }
}

export { admin };
