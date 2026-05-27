import sgMail from '@sendgrid/mail';
import { config } from '../config';

sgMail.setApiKey(config.sendgrid.apiKey);

/** Shared sender identity used by all outgoing emails. */
export const FROM = {
  email: config.sendgrid.from,
  name: config.sendgrid.fromName,
} as const;

export { sgMail };
