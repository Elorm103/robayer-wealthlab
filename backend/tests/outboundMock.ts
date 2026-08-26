/**
 * Outbound fetch mock — Version 3.0.2 Milestone M1.
 *
 * Three approaches to mocking Paystack/Resend were tried, in order:
 *   1. undici's MockAgent (Miniflare's own documented `fetchMock`
 *      option) crashes the test worker outright in this sandbox —
 *      confirmed in isolation.
 *   2. A real local Node `http.Server` on 127.0.0.1, pointed to via an
 *      env-configurable base URL — also fails: workerd's default
 *      outbound `Network` policy only permits publicly-routable
 *      addresses ("in order to prevent SSRF attacks", per miniflare's
 *      own `Network.allow`/`.deny` doc comment) and silently denies
 *      loopback/private connections, with no flag exposed through
 *      @cloudflare/vitest-pool-workers' config surface to relax it.
 *      Confirmed by adding request-received logging to that server and
 *      observing zero incoming connections while the worker's fetch()
 *      still threw `Error: internal error`.
 *   3. Miniflare's `outboundService` WorkerOptions field: a plain JS
 *      function `(request, miniflare) => Response` that intercepts
 *      every outbound fetch() the worker-under-test makes, before
 *      workerd's network layer is ever involved. This works.
 *
 * The one subtlety with (3): `outboundService` runs in the *host*
 * Node.js process (it's passed `miniflare`, the host-side controller),
 * while test files run *inside* the simulated Worker (that's the point
 * of SELF.fetch()/env — they execute in workerd's isolate). A test file
 * importing this module and a plain JS module-level variable therefore
 * do NOT share state with the outboundService function reading that
 * same-looking variable — they're two separate module instances in two
 * separate JS runtimes. Confirmed the hard way: an earlier version of
 * this file used a shared `let handler` variable and every test that
 * tried to override the default canned response silently kept getting
 * the default anyway.
 *
 * The fix: route configuration through D1 itself, which Miniflare
 * exposes identically on both sides — `env.DB` inside the worker (test
 * files) and `(await miniflare.getBindings()).DB` on the host
 * (outboundMock() below). A single `test_mock_responses` table (created
 * in tests/apply-migrations.ts, test-infrastructure only — never part
 * of the real product schema) is the shared channel. `queue*Response()`
 * functions (called from test files, with `env`) write a row;
 * `outboundMock()` (called by Miniflare, with `miniflare`) reads it.
 */
import type { Miniflare, Response as MiniflareResponse } from 'miniflare';

interface MockDbEnv {
  DB: D1Database;
}

async function queueResponse(env: MockDbEnv, key: string, response: unknown): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO test_mock_responses (key, response) VALUES (?, ?)')
    .bind(key, JSON.stringify(response))
    .run();
}

/** Overrides the next (and only the next) Paystack /transaction/initialize response. */
export async function queueInitializeResponse(env: MockDbEnv, response: unknown): Promise<void> {
  await queueResponse(env, 'paystack_initialize', response);
}

/** Overrides the Paystack /transaction/verify/{reference} response for one specific reference — not consumed, so idempotent-redelivery tests can verify the same reference twice. */
export async function queueVerifyResponse(env: MockDbEnv, reference: string, response: unknown): Promise<void> {
  await queueResponse(env, `paystack_verify:${reference}`, response);
}

/** Overrides the next (and only the next) Resend /emails response. */
export async function queueResendResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'resend_send', response);
}

/** Admin Analytics Dashboard v2 — overrides Paystack's GET /bank health-check response (services/admin/systemHealthService.ts's checkPaystack()). Not consumed (peekResponse, not takeConsumedResponse), since a health check may run more than once in one test. */
export async function queuePaystackHealthResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'paystack_bank_health', response);
}

/** Admin Analytics Dashboard v2 — overrides Resend's GET /domains health-check response (services/admin/systemHealthService.ts's checkResend()). Not consumed, same reasoning as queuePaystackHealthResponse() above. */
export async function queueResendHealthResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'resend_domains_health', response);
}

/** Overrides the next (and only the next) OpenAI /v1/chat/completions response — Version 5.0 Milestone 1 (AI Gateway). */
export async function queueOpenAiResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'openai_chat_completions', response);
}

/** Overrides the next (and only the next) OpenAI /v1/embeddings response — Version 5.0 Milestone 2 (Knowledge Base). */
export async function queueOpenAiEmbeddingResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'openai_embeddings', response);
}

/**
 * Overrides the response for GET https://robayerwealthlab.com/sitemap.xml —
 * Version 5.0 Milestone 2's static-page crawl (services/knowledge/documentSources.ts)
 * fetches its own live site's real sitemap; tests mock that fetch
 * rather than hitting the real network or the real production site.
 */
export async function queueSitemapResponse(env: MockDbEnv, xml: string): Promise<void> {
  await queueResponse(env, 'site_sitemap', xml);
}

/** Overrides the response for GET https://robayerwealthlab.com{pathname} — one entry per path, not consumed (a test may fetch the same page more than once). */
export async function queueSitePageResponse(env: MockDbEnv, pathname: string, html: string): Promise<void> {
  await queueResponse(env, `site_page:${pathname}`, html);
}

/**
 * Version 3.3 Milestone M5D.1 (Acceptance Remediation) — a PERSISTENT
 * Resend override, checked before the one-shot `queueResendResponse()`
 * queue and never auto-consumed (mirrors `queueVerifyResponse()`'s own
 * peek-based, non-consuming precedent above). Needed because a single
 * `sendEmail()` call can itself retry once internally
 * (services/emailService.ts's own `attempt < 2` loop) — a one-shot
 * queued response only covers the FIRST of those two internal
 * attempts, so simulating a genuinely transient (both-attempts-fail)
 * outage, or a failure that persists across multiple SEPARATE
 * `sendDueReviewReminders()` runs (to test retry-across-scheduled-runs
 * behavior), requires an override that survives more than one read.
 * Call `clearResendResponseStickyOverride()` when the test is done
 * simulating the outage.
 */
export async function queueResendResponseStickyOverride(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'resend_send_sticky', response);
}

/** Clears a sticky override set by `queueResendResponseStickyOverride()`, so normal (default-success or one-shot-queued) behavior resumes. */
export async function clearResendResponseStickyOverride(env: MockDbEnv): Promise<void> {
  await env.DB.prepare(`DELETE FROM test_mock_responses WHERE key = 'resend_send_sticky'`).run();
}

/** Overrides the next (and only the next) Meta Conversions API /events response — Version 5.0 (Customer Acquisition Phase 1). */
export async function queueMetaEventsResponse(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'meta_capi_events', response);
}

/**
 * A PERSISTENT Meta Conversions API override — same reasoning as
 * queueResendResponseStickyOverride() above: dispatchServerEvent()
 * itself retries once internally on a transient failure
 * (services/analytics/conversionDispatchService.ts's own
 * RETRY_MAX_ATTEMPTS loop), so a one-shot queued response only covers
 * the first of those two attempts. Use this to simulate a failure that
 * persists across both. Call clearMetaEventsResponseStickyOverride()
 * when the test is done simulating the outage.
 */
export async function queueMetaEventsResponseStickyOverride(env: MockDbEnv, response: { status: number; body: unknown }): Promise<void> {
  await queueResponse(env, 'meta_capi_events_sticky', response);
}

/** Clears a sticky override set by queueMetaEventsResponseStickyOverride(), so normal (default-success or one-shot-queued) behavior resumes. */
export async function clearMetaEventsResponseStickyOverride(env: MockDbEnv): Promise<void> {
  await env.DB.prepare(`DELETE FROM test_mock_responses WHERE key = 'meta_capi_events_sticky'`).run();
}

async function takeConsumedResponse(db: D1Database, key: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT response FROM test_mock_responses WHERE key = ?').bind(key).first<{ response: string }>();
  if (!row) return null;
  await db.prepare('DELETE FROM test_mock_responses WHERE key = ?').bind(key).run();
  return JSON.parse(row.response);
}

async function peekResponse(db: D1Database, key: string): Promise<unknown | null> {
  const row = await db.prepare('SELECT response FROM test_mock_responses WHERE key = ?').bind(key).first<{ response: string }>();
  return row ? JSON.parse(row.response) : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(status: number, body: string, contentType: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

export async function outboundMock(request: Request, miniflare: Miniflare): Promise<MiniflareResponse> {
  const url = new URL(request.url);
  const { DB } = await miniflare.getBindings<MockDbEnv>();

  if (url.hostname === 'api.paystack.co' && url.pathname === '/transaction/initialize' && request.method === 'POST') {
    const queued = await takeConsumedResponse(DB, 'paystack_initialize');
    const result = queued ?? { status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/mock', reference: 'mock-provider-ref' } };
    return json(200, result) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'api.paystack.co' && url.pathname.startsWith('/transaction/verify/') && request.method === 'GET') {
    const reference = decodeURIComponent(url.pathname.replace('/transaction/verify/', ''));
    const queued = await peekResponse(DB, `paystack_verify:${reference}`);
    const result = queued ?? { status: false, message: 'no verify handler configured for this test' };
    return json(200, result) as unknown as MiniflareResponse;
  }

  // services/admin/systemHealthService.ts's checkPaystack()/checkResend()
  // — real, safe, read-only reference-lookup calls (bank list, domain
  // list), never queued/consumed like the mutating endpoints above:
  // any number of health checks in one test run should see the same
  // default "healthy" response unless a test explicitly overrides it.
  if (url.hostname === 'api.paystack.co' && url.pathname === '/bank' && request.method === 'GET') {
    const queued = await peekResponse(DB, 'paystack_bank_health');
    if (queued) {
      const typed = queued as { status: number; body: unknown };
      return json(typed.status, typed.body) as unknown as MiniflareResponse;
    }
    return json(200, { status: true, message: 'ok', data: [] }) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'api.resend.com' && url.pathname === '/domains' && request.method === 'GET') {
    const queued = await peekResponse(DB, 'resend_domains_health');
    if (queued) {
      const typed = queued as { status: number; body: unknown };
      return json(typed.status, typed.body) as unknown as MiniflareResponse;
    }
    return json(200, { data: [] }) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'api.resend.com' && url.pathname === '/emails' && request.method === 'POST') {
    const sticky = (await peekResponse(DB, 'resend_send_sticky')) as { status: number; body: unknown } | null;
    if (sticky) return json(sticky.status, sticky.body) as unknown as MiniflareResponse;
    const queued = (await takeConsumedResponse(DB, 'resend_send')) as { status: number; body: unknown } | null;
    const result = queued ?? { status: 200, body: { id: 'mock-email-id' } };
    return json(result.status, result.body) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    const queued = (await takeConsumedResponse(DB, 'openai_chat_completions')) as { status: number; body: unknown } | null;
    const result = queued ?? {
      status: 200,
      body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 }, model: 'gpt-4o-mini' },
    };
    return json(result.status, result.body) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'api.openai.com' && url.pathname === '/v1/embeddings' && request.method === 'POST') {
    const queued = (await takeConsumedResponse(DB, 'openai_embeddings')) as { status: number; body: unknown } | null;
    if (queued) return json(queued.status, queued.body) as unknown as MiniflareResponse;

    // Default: one small, deterministic-length fake vector per input
    // text, so a test that doesn't care about the exact embedding
    // values (most don't) never needs to queue a response by hand.
    let inputCount = 1;
    try {
      const parsed = JSON.parse(await request.clone().text()) as { input?: unknown };
      if (Array.isArray(parsed.input)) inputCount = parsed.input.length;
    } catch {
      // fall through to the default of 1
    }
    const data = Array.from({ length: inputCount }, (_, i) => ({ embedding: new Array(8).fill(0).map((_, j) => (i + 1) * 0.01 + j * 0.001), index: i }));
    return json(200, { data, usage: { prompt_tokens: 10 * inputCount }, model: 'text-embedding-3-small' }) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'graph.facebook.com' && url.pathname.endsWith('/events') && request.method === 'POST') {
    const sticky = (await peekResponse(DB, 'meta_capi_events_sticky')) as { status: number; body: unknown } | null;
    if (sticky) return json(sticky.status, sticky.body) as unknown as MiniflareResponse;
    const queued = (await takeConsumedResponse(DB, 'meta_capi_events')) as { status: number; body: unknown } | null;
    const result = queued ?? { status: 200, body: { events_received: 1, fbtrace_id: 'mock-fbtrace-id' } };
    return json(result.status, result.body) as unknown as MiniflareResponse;
  }

  if (url.hostname === 'robayerwealthlab.com' && url.pathname === '/sitemap.xml' && request.method === 'GET') {
    const queued = await peekResponse(DB, 'site_sitemap');
    const xml = typeof queued === 'string' ? queued : `<?xml version="1.0"?><urlset><url><loc>https://robayerwealthlab.com/</loc></url></urlset>`;
    return textResponse(200, xml, 'application/xml') as unknown as MiniflareResponse;
  }

  if (url.hostname === 'robayerwealthlab.com' && request.method === 'GET') {
    const queued = await peekResponse(DB, `site_page:${url.pathname}`);
    if (typeof queued === 'string') return textResponse(200, queued, 'text/html') as unknown as MiniflareResponse;
    return textResponse(404, `<!doctype html><html><body><main>Not found: ${url.pathname}</main></body></html>`, 'text/html') as unknown as MiniflareResponse;
  }

  return json(502, { error: `outboundMock: unhandled request ${request.method} ${request.url}` }) as unknown as MiniflareResponse;
}
