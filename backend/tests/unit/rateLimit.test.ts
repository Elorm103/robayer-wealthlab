/**
 * Unit tests: middleware/rateLimit.ts's isRateLimited() — specifically
 * the KV-failure fallback added after the 2026-08-26 production
 * incident (RATE_LIMIT_KV hit its daily Cloudflare write quota and
 * every call site's uncaught KV error became a real 500, including on
 * checkout — see rateLimit.ts's own header comment for the full
 * writeup). These are pure unit tests against a hand-built mock
 * KVNamespace, not cloudflare:test's real (quota-less) Miniflare KV
 * simulator, specifically so a genuine `.get()`/`.put()` rejection can
 * be exercised deterministically.
 */
import { describe, it, expect, vi } from 'vitest';
import { isRateLimited } from '../../middleware/rateLimit';
import type { Env } from '../../worker/env';

function makeRequest(ip = '198.51.100.1'): Request {
  return new Request('https://example.com/api/test', { headers: { 'CF-Connecting-IP': ip } });
}

function makeEnv(kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }): Env {
  return { RATE_LIMIT_KV: kv } as unknown as Env;
}

describe('isRateLimited', () => {
  it('normal KV operation: allows a request under the limit and persists the incremented count', async () => {
    const get = vi.fn().mockResolvedValue('2');
    const put = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv({ get, put });

    const limited = await isRateLimited(makeRequest(), env, { endpoint: 'test-normal', limit: 5, windowSeconds: 60 });

    expect(limited).toBe(false);
    expect(get).toHaveBeenCalledWith('ratelimit:test-normal:198.51.100.1');
    expect(put).toHaveBeenCalledWith('ratelimit:test-normal:198.51.100.1', '3', { expirationTtl: 60 });
  });

  it('KV genuinely reports the count at the limit: blocks the request and never calls put() (unchanged, real rate-limit behavior)', async () => {
    const get = vi.fn().mockResolvedValue('5');
    const put = vi.fn();
    const env = makeEnv({ get, put });

    const limited = await isRateLimited(makeRequest(), env, { endpoint: 'test-over', limit: 5, windowSeconds: 60 });

    expect(limited).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('KV get() throws (e.g. quota exceeded): does not throw, falls back to allowing the request instead of crashing the caller', async () => {
    const get = vi.fn().mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
    const put = vi.fn();
    const env = makeEnv({ get, put });

    await expect(
      isRateLimited(makeRequest('198.51.100.2'), env, { endpoint: 'kv-fail-get', limit: 5, windowSeconds: 60 })
    ).resolves.toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it('KV put() throws after a successful get(): still does not throw, and still allows the request (the get() already proved it was under the limit)', async () => {
    const get = vi.fn().mockResolvedValue('1');
    const put = vi.fn().mockRejectedValue(new Error('KV put() limit exceeded for the day.'));
    const env = makeEnv({ get, put });

    await expect(
      isRateLimited(makeRequest('198.51.100.3'), env, { endpoint: 'kv-fail-put', limit: 5, windowSeconds: 60 })
    ).resolves.toBe(false);
  });

  it('logs a structured warning distinguishing "KV unavailable" from an ordinary RATE_LIMITED decision', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
    const env = makeEnv({ get, put: vi.fn() });

    await isRateLimited(makeRequest('198.51.100.4'), env, { endpoint: 'kv-fail-log', limit: 5, windowSeconds: 60 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.level).toBe('warn');
    expect(logged.message).toBe('rate_limit.kv_unavailable');
    expect(logged.context).toMatchObject({ operation: 'get', endpoint: 'kv-fail-log' });

    warnSpy.mockRestore();
  });

  it('a put() failure logs operation "put", distinct from a get() failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.fn().mockResolvedValue('0');
    const put = vi.fn().mockRejectedValue(new Error('KV put() limit exceeded for the day.'));
    const env = makeEnv({ get, put });

    await isRateLimited(makeRequest('198.51.100.6'), env, { endpoint: 'kv-fail-put-log', limit: 5, windowSeconds: 60 });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.context).toMatchObject({ operation: 'put', endpoint: 'kv-fail-put-log' });

    warnSpy.mockRestore();
  });

  it('the in-memory fallback backstop still throttles a sustained flood while KV is down, rather than admitting every request unconditionally', async () => {
    const get = vi.fn().mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
    const env = makeEnv({ get, put: vi.fn() });
    const ip = '198.51.100.5';
    const options = { endpoint: 'kv-fail-flood', limit: 2, windowSeconds: 60 };

    // Fallback multiplier is 3x the real limit (see rateLimit.ts) - with
    // limit=2, the first 6 requests on this key are absorbed by the
    // backstop before the 7th is blocked.
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(await isRateLimited(makeRequest(ip), env, options));
    }

    expect(results.slice(0, 6)).toEqual(new Array(6).fill(false));
    expect(results[6]).toBe(true);
  });
});
