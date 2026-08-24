import { db } from '../db';
import { contactMessages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { sendContactMessageEmail } from '../emails';
import { logger } from '../lib/logger';

export interface ContactSubmission {
  name: string;
  email: string;
  subject: string;
  message: string;
  userId: number | null;
}

export const contactService = {
  /**
   * Records the message, then tries to email it on.
   *
   * The write comes first and the send is allowed to fail. A customer who has
   * just described a problem should not be told "something went wrong" because
   * our mail provider is having an afternoon — from their side the message was
   * sent, and it was: the row exists. `emailed_at` stays null on the ones that
   * need chasing.
   */
  async submit(input: ContactSubmission): Promise<{ id: number }> {
    const [row] = await db
      .insert(contactMessages)
      .values({
        userId: input.userId,
        name: input.name,
        email: input.email,
        subject: input.subject,
        message: input.message,
      })
      .returning({ id: contactMessages.id });

    try {
      await sendContactMessageEmail({ ...input, id: row.id });
      await db
        .update(contactMessages)
        .set({ emailed: new Date() })
        .where(eq(contactMessages.id, row.id));
    } catch (err) {
      logger.error('Contact message stored but not emailed', {
        contactMessageId: row.id,
        error: (err as Error).message,
      });
    }

    return { id: row.id };
  },
};
