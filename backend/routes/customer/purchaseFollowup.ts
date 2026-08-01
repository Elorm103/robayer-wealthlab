/**
 * GET /api/customer/purchase-followup/opt-out — Version 4.0 Milestone
 * C1 (Core Email Lifecycle). See
 * services/customer/purchaseFollowupService.ts's optOutOfPurchaseFollowups().
 *
 * Deliberate near-exact copy of routes/customer/reviewReminders.ts —
 * same single-GET-action shape, same reasoning (a low-stakes
 * preference, not a compliance-grade unsubscribe; a reused/forwarded
 * link can at worst opt someone out of a follow-up email again).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { isRateLimited } from '../../middleware/rateLimit';
import { optOutOfPurchaseFollowups } from '../../services/customer/purchaseFollowupService';

const RATE_LIMIT = { endpoint: 'customer-purchase-followup-opt-out', limit: 20, windowSeconds: 60 };

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
<title>Purchase follow-ups | Robayer WealthLab</title>
<meta name="robots" content="noindex, nofollow">
</head>
<body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #16233D;">
<p>${message}</p>
<p><a href="/">Return to Robayer WealthLab</a></p>
</body>
</html>`;

export async function handlePurchaseFollowupOptOut(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return htmlResponse(PAGE('Too many requests. Please try again in a minute.'), 429);
  }

  const token = new URL(request.url).searchParams.get('token');
  await optOutOfPurchaseFollowups(env, logger, token);

  return htmlResponse(PAGE("You won't receive any more purchase check-in emails from us."));
}
