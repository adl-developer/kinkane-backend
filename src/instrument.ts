// Sentry must be initialised before the rest of the app's module graph loads,
// so its instrumentation is in place first. Import declarations are evaluated
// before any statement in the importing module runs, so `import './instrument'`
// as the very first import of server.ts guarantees this init runs before
// './app' (and Express) are pulled in. A no-op when SENTRY_DSN is unset.
import { initSentry } from './lib/sentry';

initSentry();
