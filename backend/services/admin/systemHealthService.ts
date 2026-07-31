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
 */

import type { Env } from '../../worker/env';
import { getSettingsStatus } from './settingsService';

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

/** Reads the heartbeat backend/worker/index.ts's scheduled() handler writes on every Cron Trigger invocation (added alongside this milestone) — a genuine "did Cron fire" signal, not inferred from whether there happened to be a reminder due to send that day. */
async function checkCron(env: Env): Promise<HealthCheckItem> {
  const row = await env.DB.prepare(
    `SELECT created_at AS createdAt, metadata FROM audit_logs WHERE actor_type = 'system' AND action = 'cron.heartbeat' ORDER BY id DESC LIMIT 1`
  ).first<{ createdAt: string; metadata: string | null }>();

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

async function computeSystemHealth(env: Env, request: Request): Promise<SystemHealth> {
  const [website, database, storage, paystack, resend, cron, settings] = await Promise.all([
    checkWebsite(env),
    checkDatabase(env),
    checkStorage(env),
    checkPaystack(env),
    checkResend(env),
    checkCron(env),
    getSettingsStatus(env, request),
  ]);

  const worker = checkWorker();
  const checks = [website, worker, database, storage, paystack, resend, cron];

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
  const cachedRaw = await env.RATE_LIMIT_KV.get(HEALTH_CACHE_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as SystemHealth;
      return { ...cached, cached: true };
    } catch {
      // Fall through to a fresh computation on a corrupt cache entry.
    }
  }

  const health = await computeSystemHealth(env, request);
  await env.RATE_LIMIT_KV.put(HEALTH_CACHE_KEY, JSON.stringify(health), { expirationTtl: HEALTH_CACHE_TTL_SECONDS });
  return health;
}
