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

  if (url.hostname === 'api.resend.com' && url.pathname === '/emails' && request.method === 'POST') {
    const queued = (await takeConsumedResponse(DB, 'resend_send')) as { status: number; body: unknown } | null;
    const result = queued ?? { status: 200, body: { id: 'mock-email-id' } };
    return json(result.status, result.body) as unknown as MiniflareResponse;
  }

  return json(502, { error: `outboundMock: unhandled request ${request.method} ${request.url}` }) as unknown as MiniflareResponse;
}
