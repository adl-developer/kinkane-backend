import admin from 'firebase-admin';
import { config } from '../config';

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebase.projectId,
        clientEmail: config.firebase.clientEmail,
        privateKey: config.firebase.privateKey?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (err) {
    console.warn('[firebase] Init failed — Firebase will be unavailable:', (err as Error).message);
  }
}

export { admin };
