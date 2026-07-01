// Transactional
export { sendWelcomeEmail } from './transactional/welcome';
export { sendVerifyEmail } from './transactional/verify-email';
export { sendPasswordResetEmail } from './transactional/password-reset';
export { sendPasswordChangedEmail } from './transactional/password-changed';
export { sendAccountDeletedEmail } from './transactional/account-deleted';
export { sendEmailChangeOtpEmail } from './transactional/email-change-otp';
export { sendEmailChangeNotifyEmail } from './transactional/email-change-notify';
export { sendFollowRequestEmail, sendFollowAcceptedEmail } from './transactional/follow-request';
export { sendRateReviewReminderEmail } from './transactional/rate-review-reminder';
export { sendPostCommentEmail } from './transactional/post-comment';
export { sendPostLikeEmail } from './transactional/post-like';

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
