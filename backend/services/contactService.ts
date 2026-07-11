/**
 * Records a general enquiry into contact_messages and sends the
 * contact-acknowledgement email — see docs/database-design.md's
 * `contact_messages` section for why this is a separate table/service
 * from consultation_requests rather than a shared one.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { sendEmail } from './emailService';

export interface SubmitContactMessageInput {
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

export interface SubmitContactMessageResult {
  status: 'received';
}

export async function submitContactMessage(
  env: Env,
  logger: Logger,
  input: SubmitContactMessageInput
): Promise<SubmitContactMessageResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)`
  )
    .bind(input.name, input.email, input.phone, input.message)
    .run();

  const messageId = Number(inserted.meta.last_row_id);

  await sendEmail(env, logger, {
    template: 'contact-acknowledgement',
    to: input.email,
    data: { name: input.name, message: input.message },
    entityType: 'contact_message',
    entityId: messageId,
  });

  return { status: 'received' };
}
