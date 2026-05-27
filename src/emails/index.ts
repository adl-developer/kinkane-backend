// Transactional
export { sendWelcomeEmail } from './transactional/welcome';
export { sendVerifyEmail } from './transactional/verify-email';
export { sendPasswordResetEmail } from './transactional/password-reset';

// Notifications
export { sendTrialEndingEmail } from './notifications/trial-ending';
export { sendNewRecommendationEmail } from './notifications/new-recommendation';
export type { RecommendedBook } from './notifications/new-recommendation';

// Marketing
export { sendNewsletterEmail } from './marketing/newsletter';
export type { NewsletterPayload } from './marketing/newsletter';

// Reports
export { sendWeeklyDigestEmail } from './reports/weekly-digest';
export type { WeeklyDigestPayload } from './reports/weekly-digest';
