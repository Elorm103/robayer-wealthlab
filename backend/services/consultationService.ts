/**
 * Records a consultation request into consultation_requests and sends
 * the consultation-acknowledgement email — see
 * docs/email-architecture.md's "Required templates" #2 for why that
 * email must restate "not a booking confirmation," matching the same
 * honesty already required on consultation/index.html.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { sendEmail } from './emailService';

export type PreferredContactMethod = 'email' | 'phone';

export interface SubmitConsultationInput {
  name: string;
  email: string;
  phone: string | null;
  country: string;
  category: string;
  description: string;
  preferredContactMethod: PreferredContactMethod;
  consentGiven: boolean;
}

export interface SubmitConsultationResult {
  status: 'received';
}

export async function submitConsultationRequest(
  env: Env,
  logger: Logger,
  input: SubmitConsultationInput
): Promise<SubmitConsultationResult> {
  const inserted = await env.DB.prepare(
    `INSERT INTO consultation_requests
       (name, email, phone, country, category, description, preferred_contact_method, consent_given)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.name,
      input.email,
      input.phone,
      input.country,
      input.category,
      input.description,
      input.preferredContactMethod,
      input.consentGiven ? 1 : 0
    )
    .run();

  const requestId = Number(inserted.meta.last_row_id);

  await sendEmail(env, logger, {
    template: 'consultation-acknowledgement',
    to: input.email,
    data: {
      name: input.name,
      category: input.category,
      preferredContactMethod: input.preferredContactMethod,
    },
    entityType: 'consultation_request',
    entityId: requestId,
  });

  return { status: 'received' };
}
