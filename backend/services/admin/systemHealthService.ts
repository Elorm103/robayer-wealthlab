/**
 * System Health Service — Version 3.5 (Executive Dashboard & Business
 * Intelligence), Phase 1 (Executive Health Panel).
 *
 * Every check here is a real, live probe or a real, live D1 aggregate —
 * per the milestone brief's explicit "no fake health checks" rule,
 * nothing here is hardcoded to "healthy." A check that cannot honestly
 * be answered (e.g. R2 has no bucket-size API on the binding) is never
 * built here at all rather than faked.
 *
 * Reuses services/admin/settingsService.ts's already-real
 * getSettingsStatus() for Paystack/Resend configuration state, Worker
 * version, deployment metadata, and current schema migration, rather
 * than re-deriving any of that — this service only adds the checks
 * settingsService.ts does not already answer: website reachability,
 * D1 connectivity, R2 availability, live Paystack/Resend API
 * connectivity, and Cron heartbeat freshness (see
 * backend/worker/index.ts's scheduled() handler, which writes the
 * 'cron.heartbeat' audit_logs row this reads).
 *
 * Cached in RATE_LIMIT_KV for 60 seconds (Phase 13 performance):
 * every check here either makes a live outbound HTTP call (website,
 * Paystack, Resend) or a live D1/R2 round trip, so an executive
 * dashboard left open and auto-refreshing must not re-run all of these
 * on every poll. 60 seconds is short enough that "is the site down
 * right now" is never meaningfully stale for a human looking at a
 * dashboard, and long enough to make repeated loads within that window
 * free.
 *
 * Admin Analytics Dashboard v2 (2026-08-27) — this endpoint
 * (GET /api/admin/dashboard/health) already existed and already
 * worked; the Analytics page (admin/analytics/index.html) simply
 * never called it — System Health has only ever lived on the separate
 * Executive Dashboard (admin/index.html, js/components/admin/admin-
 * dashboard.js). Reused here as-is (the Analytics page's own new
 * System Health section fetches this SAME endpoint) rather than
 * duplicated, per that investigation's own "use the existing
 * architecture" conclusion.
 *
 * Two real gaps fixed in the same pass: (1) getSystemHealth()'s own
 * cache-write KV call had no error handling — during the 2026-08-26
 * RATE_LIMIT_KV incident, a cache-miss health check would itself have
 * thrown trying to CACHE its answer, meaning the one endpoint whose
 * entire job is reporting infrastructure trouble could itself go
 * down because of that exact trouble. Now caught and treated as
 * "skip the cache write," never as a reason to fail the request. (2)
 * No check here ever probed RATE_LIMIT_KV's WRITE capacity directly,
 * Analytics' pipeline freshness, or Online Now's presence-lookup path
 * — checkRateLimitKv()/checkAnalytics()/checkOnlineNow() below close
 * that, plus a derived Checkout/Paystack check that explicitly does
 * NOT inherit RATE_LIMIT_KV's degraded status, since the fail-open fix
 * in middleware/rateLimit.ts means checkout no longer depends on it.
 */

import type { Env } from '../../worker/env';
import { getSettingsStatus } from './settingsService';
import { getOnlineNowCount } from './analyticsService';

export type HealthStatus = 'healthy' | 'warning' | 'error';

export interface HealthCheckItem {
  key: string;
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface SystemHealth {
  overallStatus: HealthStatus;
  checks: HealthCheckItem[];
  appVersion: string;
  environment: 'production' | 'development';
  schemaVersion: string | null;
  checkedAt: string;
  cached: boolean;
}

const HEALTH_CACHE_KEY = 'system-health:v1';
const HEALTH_CACHE_TTL_SECONDS = 60;
const OUTBOUND_TIMEOUT_MS = 5000;

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The live static site (GitHub Pages, fronted by Cloudflare) — a separate system from this Worker, genuinely worth checking independently: one can be down while the other is healthy. */
async function checkWebsite(env: Env): Promise<HealthCheckItem> {
  try {
    const res = await fetchWithTimeout(env.SITE_BASE_URL + '/', { method: 'GET' }, OUTBOUND_TIMEOUT_MS);
    if (res.ok) return { key: 'website', label: 'Website Online', status: 'healthy', detail: `Responded with HTTP ${res.status}.` };
    return { key: 'website', label: 'Website Online', status: 'error', detail: `Responded with HTTP ${res.status}.` };
  } catch (err) {
    return { key: 'website', label: 'Website Online', status: 'error', detail: err instanceof Error ? err.message : 'Request failed.' };
  }
}

/** Trivially true by construction: this code is executing inside the Worker that would need to be "responding" for this very request to reach it. Reported for completeness, matching the brief's explicit checklist, not because it can ever meaningfully fail here. */
function checkWorker(): HealthCheckItem {
  return { key: 'worker', label: 'Worker Healthy', status: 'healthy', detail: 'This request was served by the Worker.' };
}

async function checkDatabase(env: Env): Promise<HealthCheckItem> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    if (row?.ok === 1) return { key: 'database', label: 'Database Connected', status: 'healthy', detail: 'D1 query succeeded.' };
    return { key: 'database', label: 'Database Connected', status: 'error', detail: 'D1 query returned an unexpected result.' };
  } catch (err) {
    return { key: 'database', label: 'Database Connected', status: 'error', detail: err instanceof Error ? err.message : 'D1 query failed.' };
  }
}

async function checkStorage(env: Env): Promise<HealthCheckItem> {
  try {
    await env.STORAGE.list({ limit: 1 });
    return { key: 'storage', label: 'Storage Healthy', status: 'healthy', detail: 'R2 list succeeded.' };
  } catch (err) {
    return { key: 'storage', label: 'Storage Healthy', status: 'error', detail: err instanceof Error ? err.message : 'R2 call failed.' };
  }
}

/**
 * A real, live, side-effect-free call — Paystack's bank-list endpoint
 * is a static reference lookup (never mutates anything, never touches
 * a real transaction), so this proves the secret key is genuinely
 * valid and Paystack's API is reachable, not just that a key string is
 * present.
 */
async function checkPaystack(env: Env): Promise<HealthCheckItem> {
  if (!env.PAYSTACK_SECRET_KEY) {
    return { key: 'paystack', label: 'Paystack Connected', status: 'error', detail: 'PAYSTACK_SECRET_KEY is not configured.' };
  }
  try {
    const res = await fetchWithTimeout(
      `${env.PAYSTACK_BASE_URL}/bank?currency=GHS`,
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
      OUTBOUND_TIMEOUT_MS
    );
    if (res.ok) return { key: 'paystack', label: 'Paystack Connected', status: 'healthy', detail: 'API key verified against a live Paystack API call.' };
    if (res.status === 401) return { key: 'paystack', label: 'Paystack Connected', status: 'error', detail: 'Paystack rejected the configured secret key (401).' };
    return { key: 'paystack', label: 'Paystack Connected', status: 'warning', detail: `Paystack API responded with HTTP ${res.status}.` };
  } catch (err) {
    return { key: 'paystack', label: 'Paystack Connected', status: 'warning', detail: err instanceof Error ? err.message : 'Paystack API call failed.' };
  }
}

/** Same reasoning as checkPaystack(): Resend's domain-list endpoint is a real, safe, read-only call that proves the API key actually works, without sending any email. */
async function checkResend(env: Env): Promise<HealthCheckItem> {
  if (!env.RESEND_API_KEY) {
    return { key: 'resend', label: 'Resend Connected', status: 'error', detail: 'RESEND_API_KEY is not configured.' };
  }
  try {
    const res = await fetchWithTimeout(
      `${env.RESEND_BASE_URL}/domains`,
      { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } },
      OUTBOUND_TIMEOUT_MS
    );
    if (res.ok) return { key: 'resend', label: 'Resend Connected', status: 'healthy', detail: 'API key verified against a live Resend API call.' };
    if (res.status === 401 || res.status === 403) return { key: 'resend', label: 'Resend Connected', status: 'error', detail: `Resend rejected the configured API key (${res.status}).` };
    return { key: 'resend', label: 'Resend Connected', status: 'warning', detail: `Resend API responded with HTTP ${res.status}.` };
  } catch (err) {
    return { key: 'resend', label: 'Resend Connected', status: 'warning', detail: err instanceof Error ? err.message : 'Resend API call failed.' };
  }
}

/** Reads the heartbeat backend/worker/index.ts's scheduled() handler writes on every Cron Trigger invocation (added alongside this milestone) — a genuine "did Cron fire" signal, not inferred from whether there happened to be a reminder due to send that day. Admin Analytics Dashboard v2: wrapped in its own try/catch (previously relied on the D1 query never throwing) now that this endpoint is load-bearing on a more prominent page — a query failure here must degrade this one check, not the whole health response. */
async function checkCron(env: Env): Promise<HealthCheckItem> {
  let row: { createdAt: string; metadata: string | null } | null;
  try {
    row = await env.DB.prepare(
      `SELECT created_at AS createdAt, metadata FROM audit_logs WHERE actor_type = 'system' AND action = 'cron.heartbeat' ORDER BY id DESC LIMIT 1`
    ).first<{ createdAt: string; metadata: string | null }>();
  } catch (err) {
    return { key: 'cron', label: 'Cron Ran Today', status: 'warning', detail: err instanceof Error ? err.message : 'Cron heartbeat query failed.' };
  }

  if (!row) {
    return { key: 'cron', label: 'Cron Ran Today', status: 'warning', detail: 'No Cron execution has been recorded yet since this check was introduced.' };
  }

  const ageMs = Date.now() - new Date(row.createdAt.replace(' ', 'T') + 'Z').getTime();
  const ranWithinWindow = ageMs < 30 * 60 * 60 * 1000; // Cron runs once daily; 30h tolerates viewing at any time of day.

  let ok = true;
  try {
    ok = row.metadata ? JSON.parse(row.metadata).ok !== false : true;
  } catch {
    ok = true;
  }

  if (!ranWithinWindow) {
    return { key: 'cron', label: 'Cron Ran Today', status: 'error', detail: `Last execution was ${row.createdAt} (more than 30 hours ago).` };
  }
  if (!ok) {
    return { key: 'cron', label: 'Cron Ran Today', status: 'warning', detail: `Last execution at ${row.createdAt} reported an error.` };
  }
  return { key: 'cron', label: 'Cron Ran Today', status: 'healthy', detail: `Last execution at ${row.createdAt}.` };
}

const RATE_LIMIT_KV_HEALTH_PROBE_KEY = 'system-health:kv-write-probe';

/**
 * Admin Analytics Dashboard v2 — a real, honest probe of
 * RATE_LIMIT_KV's WRITE capacity specifically, not just its
 * connectivity. A plain `.get()` would NOT prove this: per
 * Cloudflare's own Workers KV platform limits, reads (100,000/day)
 * and writes (1,000/day) are separately-metered quotas, and the
 * 2026-08-26 incident was specifically a write-quota exhaustion — a
 * check that only reads would report "healthy" straight through that
 * exact incident, which this check must never do. This only ever runs
 * on a cache miss (same as every other check here, gated by
 * getSystemHealth()'s own 60s cache), so the extra write this costs
 * is small and bounded, not per-page-load. 'warning', never 'error':
 * this condition is exactly what middleware/rateLimit.ts's fail-open
 * fix exists to make non-critical.
 */
async function checkRateLimitKv(env: Env): Promise<HealthCheckItem> {
  try {
    await env.RATE_LIMIT_KV.put(RATE_LIMIT_KV_HEALTH_PROBE_KEY, String(Date.now()), { expirationTtl: 120 });
    return { key: 'rateLimitKv', label: 'Rate Limiting (RATE_LIMIT_KV)', status: 'healthy', detail: 'A live write to RATE_LIMIT_KV succeeded.' };
  } catch (err) {
    return {
      key: 'rateLimitKv',
      label: 'Rate Limiting (RATE_LIMIT_KV)',
      status: 'warning',
      detail: 'Cloudflare KV unavailable or quota exhausted. ' + (err instanceof Error ? err.message : 'Write failed.'),
    };
  }
}

/**
 * Admin Analytics Dashboard v2 — deliberately separate from
 * checkRateLimitKv() above: KV `.list()` operations draw from their
 * OWN 1,000/day quota, distinct from `.put()`'s, per Cloudflare's
 * platform limits — Online Now can be broken independently of, or
 * stay healthy despite, a write-quota exhaustion. Reuses
 * getOnlineNowCount() exactly as the dashboard's own Online Now card
 * does, rather than re-implementing the same list() call a second
 * time.
 */
async function checkOnlineNow(env: Env): Promise<HealthCheckItem> {
  try {
    const count = await getOnlineNowCount(env);
    return { key: 'onlineNow', label: 'Online Now / Heartbeat', status: 'healthy', detail: `Presence lookup succeeded (${count} online now).` };
  } catch (err) {
    return {
      key: 'onlineNow',
      label: 'Online Now / Heartbeat',
      status: 'warning',
      detail: 'Cloudflare KV unavailable or quota exhausted for presence lookups. ' + (err instanceof Error ? err.message : 'Lookup failed.'),
    };
  }
}

/**
 * Admin Analytics Dashboard v2 — a genuinely different signal from
 * checkDatabase(): D1 could be fully reachable while the analytics
 * pipeline itself has gone quiet for some other reason (a client-side
 * regression, a stale cached analytics.js, etc.). 'warning', never
 * 'error', for staleness alone — zero events in the last 24h is
 * ambiguous between "broken" and "genuinely quiet" at this project's
 * real traffic scale, and this check must never manufacture false
 * urgency from ordinary quiet.
 */
async function checkAnalytics(env: Env): Promise<HealthCheckItem> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM analytics_events WHERE created_at > datetime('now', '-24 hours')`
    ).first<{ c: number }>();
    const count = row?.c ?? 0;
    if (count > 0) {
      return { key: 'analytics', label: 'Analytics', status: 'healthy', detail: `${count} event${count === 1 ? '' : 's'} recorded in the last 24 hours.` };
    }
    return { key: 'analytics', label: 'Analytics', status: 'warning', detail: 'No analytics events recorded in the last 24 hours — could mean no traffic, or a tracking issue.' };
  } catch (err) {
    return { key: 'analytics', label: 'Analytics', status: 'error', detail: err instanceof Error ? err.message : 'analytics_events query failed.' };
  }
}

/**
 * Admin Analytics Dashboard v2 — a DERIVED check, computed from
 * checkPaystack() and checkRateLimitKv() rather than re-probing
 * either. The exact distinction the 2026-08-26 incident exists to
 * teach this dashboard: checkout's payment path depends on Paystack
 * being reachable, NOT on RATE_LIMIT_KV — middleware/rateLimit.ts's
 * fail-open fix means a KV outage no longer blocks checkout, so this
 * must never report checkout as degraded/down purely because
 * rateLimitKv is. rateLimitKv's own degraded status is still shown
 * honestly elsewhere in the same checks array — this function only
 * controls what CHECKOUT specifically claims.
 */
function deriveCheckoutHealth(paystack: HealthCheckItem, rateLimitKv: HealthCheckItem): HealthCheckItem {
  if (paystack.status === 'error') {
    return {
      key: 'checkout',
      label: 'Checkout / Paystack',
      status: 'error',
      detail: 'Paystack is unreachable or misconfigured — checkout cannot complete payments. ' + paystack.detail,
    };
  }
  if (paystack.status === 'warning') {
    return { key: 'checkout', label: 'Checkout / Paystack', status: 'warning', detail: 'Paystack API check was inconclusive. ' + paystack.detail };
  }
  if (rateLimitKv.status !== 'healthy') {
    return {
      key: 'checkout',
      label: 'Checkout / Paystack',
      status: 'healthy',
      detail: 'Checkout available; rate limiting is operating in fallback mode (RATE_LIMIT_KV degraded, but checkout does not depend on it).',
    };
  }
  return { key: 'checkout', label: 'Checkout / Paystack', status: 'healthy', detail: 'Paystack reachable; rate limiting operating normally.' };
}

async function computeSystemHealth(env: Env, request: Request): Promise<SystemHealth> {
  const [website, database, storage, paystack, resend, cron, settings, rateLimitKv, onlineNow, analytics] = await Promise.all([
    checkWebsite(env),
    checkDatabase(env),
    checkStorage(env),
    checkPaystack(env),
    checkResend(env),
    checkCron(env),
    getSettingsStatus(env, request),
    checkRateLimitKv(env),
    checkOnlineNow(env),
    checkAnalytics(env),
  ]);

  const worker = checkWorker();
  const checkout = deriveCheckoutHealth(paystack, rateLimitKv);
  const checks = [website, worker, database, storage, rateLimitKv, analytics, onlineNow, paystack, resend, checkout, cron];

  return {
    overallStatus: worstStatus(checks.map((c) => c.status)),
    checks,
    appVersion: settings.system.appVersion.value,
    environment: settings.system.environment.value,
    schemaVersion: settings.system.currentMigration.value,
    checkedAt: new Date().toISOString(),
    cached: false,
  };
}

export async function getSystemHealth(env: Env, request: Request): Promise<SystemHealth> {
  // Both KV calls below are wrapped: this is the ONE endpoint whose
  // entire job is reporting infrastructure trouble honestly, so it
  // must never itself fail BECAUSE of the exact trouble it is trying
  // to report — see this file's own header comment for the
  // 2026-08-26 incident this fixes.
  const cachedRaw = await env.RATE_LIMIT_KV.get(HEALTH_CACHE_KEY).catch(() => null);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as SystemHealth;
      return { ...cached, cached: true };
    } catch {
      // Fall through to a fresh computation on a corrupt cache entry.
    }
  }

  const health = await computeSystemHealth(env, request);
  try {
    await env.RATE_LIMIT_KV.put(HEALTH_CACHE_KEY, JSON.stringify(health), { expirationTtl: HEALTH_CACHE_TTL_SECONDS });
  } catch {
    // Caching is a performance optimization (see this file's header
    // comment), not a correctness requirement. If RATE_LIMIT_KV can't
    // even take this write, checkRateLimitKv() above already
    // captured that fact honestly in `health.checks` — the caller
    // still gets a complete, accurate answer, just not cached for the
    // next 60s.
  }
  return health;
}
