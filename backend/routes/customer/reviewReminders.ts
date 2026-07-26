/**
 * GET /api/customer/review-reminders/opt-out — Version 3.3 Milestone
 * M5C Phase 5 (Review Lifecycle). See
 * services/customer/reviewReminderService.ts's optOutOfReviewReminders().
 *
 * Deliberately a single GET action, not the two-step GET-status/POST-
 * confirm pattern routes/unsubscribe.ts uses — that extra step exists
 * there because a newsletter unsubscribe is a real compliance action
 * with an RFC 8058 List-Unsubscribe-Post header pointing at it. This
 * opt-out has neither concern: it's a low-stakes preference (see
 * migration 0021's own header comment — a reused/forwarded link can at
 * worst opt someone out of a reminder email again, never grant access
 * to anything), so a single click completing the action immediately is
 * the simpler, proportionate choice. Returns a small server-rendered
 * HTML page directly (matching routes/free-guide.ts's own precedent
 * for a simple confirmation page with no dedicated static frontend
 * route), since this is a link opened straight from an email, not an
 * in-app fetch() call.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { isRateLimited } from '../../middleware/rateLimit';
import { optOutOfReviewReminders } from '../../services/customer/reviewReminderService';

const RATE_LIMIT = { endpoint: 'customer-review-reminder-opt-out', limit: 20, windowSeconds: 60 };

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const PAGE = (message: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Review reminders | Robayer WealthLab</title>
<meta name="robots" content="noindex, nofollow">
</head>
<body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #16233D;">
<p>${message}</p>
<p><a href="/">Return to Robayer WealthLab</a></p>
</body>
</html>`;

export async function handleReviewReminderOptOut(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return htmlResponse(PAGE('Too many requests. Please try again in a minute.'), 429);
  }

  const token = new URL(request.url).searchParams.get('token');
  await optOutOfReviewReminders(env, logger, token);

  // Always the same message regardless of whether the token matched
  // anything real — see optOutOfReviewReminders()'s own "silent no-op"
  // reasoning.
  return htmlResponse(PAGE("You won't receive any more review-reminder emails from us."));
}
