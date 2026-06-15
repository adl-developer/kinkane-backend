import { Worker, Job } from 'bullmq';
import { bullConnection, EmailJobMap, EmailJobName } from '../lib/email-queue';
import {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountDeletedEmail,
  sendTrialEndingEmail,
  sendNewRecommendationEmail,
  sendNewsletterEmail,
  sendWeeklyDigestEmail,
  sendEmailChangeOtpEmail,
  sendEmailChangeNotifyEmail,
  sendFollowRequestEmail,
  sendFollowAcceptedEmail,
} from '../emails';
import { logger } from '../lib/logger';

// ── Job processor ─────────────────────────────────────────────────────────────

async function processEmailJob(job: Job): Promise<void> {
  const name = job.name as EmailJobName;

  switch (name) {
    case 'welcome': {
      const { to, name: userName } = job.data as EmailJobMap['welcome'];
      await sendWelcomeEmail(to, userName);
      break;
    }
    case 'password-reset': {
      const { to, name: userName, resetUrl } = job.data as EmailJobMap['password-reset'];
      await sendPasswordResetEmail(to, userName, resetUrl);
      break;
    }
    case 'password-changed': {
      const { to, name: userName } = job.data as EmailJobMap['password-changed'];
      await sendPasswordChangedEmail(to, userName);
      break;
    }
    case 'account-deleted': {
      const { to, name: userName } = job.data as EmailJobMap['account-deleted'];
      await sendAccountDeletedEmail(to, userName);
      break;
    }
    case 'trial-ending': {
      const { to, name: userName, daysLeft } = job.data as EmailJobMap['trial-ending'];
      await sendTrialEndingEmail(to, userName, daysLeft);
      break;
    }
    case 'new-recommendation': {
      const { to, name: userName, book } = job.data as EmailJobMap['new-recommendation'];
      await sendNewRecommendationEmail(to, userName, book);
      break;
    }
    case 'newsletter': {
      const { to, payload } = job.data as EmailJobMap['newsletter'];
      await sendNewsletterEmail(to, payload);
      break;
    }
    case 'weekly-digest': {
      const { to, payload } = job.data as EmailJobMap['weekly-digest'];
      await sendWeeklyDigestEmail(to, payload);
      break;
    }
    case 'email-change-otp': {
      const { to, name: userName, otp, expiryMinutes } = job.data as EmailJobMap['email-change-otp'];
      await sendEmailChangeOtpEmail(to, userName, otp, expiryMinutes);
      break;
    }
    case 'email-change-notify': {
      const { to, name: userName, cancelUrl } = job.data as EmailJobMap['email-change-notify'];
      await sendEmailChangeNotifyEmail(to, userName, cancelUrl);
      break;
    }
    case 'follow-request': {
      const { to, receiverName, senderName } = job.data as EmailJobMap['follow-request'];
      await sendFollowRequestEmail(to, receiverName, senderName);
      break;
    }
    case 'follow-accepted': {
      const { to, senderName, accepterName } = job.data as EmailJobMap['follow-accepted'];
      await sendFollowAcceptedEmail(to, senderName, accepterName);
      break;
    }
    default: {
      // Exhaustiveness check — TypeScript will catch unhandled job names at compile time
      const unhandled: never = name;
      logger.warn('Unknown email job type — skipping', { jobName: unhandled });
    }
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

export function startEmailWorker(): Worker {
  const worker = new Worker('emails', processEmailJob, {
    connection: bullConnection,
    concurrency: 5, // process up to 5 emails simultaneously — respects SendGrid rate limits
  });

  worker.on('completed', (job) => {
    logger.info('Email job completed', {
      jobId: job.id,
      jobName: job.name,
      to: (job.data as { to: string }).to,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Email job failed', {
      jobId: job?.id,
      jobName: job?.name,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
      error: err.message,
    });
  });

  logger.info('Email worker started', { concurrency: 5 });
  return worker;
}

export async function stopEmailWorker(worker: Worker): Promise<void> {
  // Waits for the currently active job (if any) to finish before closing
  await worker.close();
  logger.info('Email worker stopped');
}
