/**
 * Unit tests: settingsService's Phase 6A pilot allowlist —
 * controlled_reader_pilot_customer_ids and
 * isControlledReaderEnabledForCustomer(). Scoped only to what this
 * phase added; the pre-existing controlled_reader_enabled flag has its
 * own coverage in tests/integration/controlledReader.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { updateSettings, isControlledReaderEnabledForCustomer, isControlledReaderEnabled } from '../../services/admin/settingsService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');
const CTX = { ip: null, userAgent: null };

describe('settingsService — Phase 6A pilot allowlist', () => {
  let adminId: number;

  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'controlled_reader%'`);
    await env.DB.exec('DELETE FROM audit_logs');
    await env.DB.exec('DELETE FROM admin_users');
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('pilot-allowlist-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
  });

  it('defaults to an empty allowlist and the global flag off — a real, never-configured environment behaves exactly as it did before this phase', async () => {
    expect(await isControlledReaderEnabled(env as any)).toBe(false);
    expect(await isControlledReaderEnabledForCustomer(env as any, 12345)).toBe(false);
  });

  it('a customer id added via updateSettings() is granted access with the global flag off; a different real customer id is not', async () => {
    const result = await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [42, 99] }, CTX);
    expect(result.ok).toBe(true);

    expect(await isControlledReaderEnabledForCustomer(env as any, 42)).toBe(true);
    expect(await isControlledReaderEnabledForCustomer(env as any, 99)).toBe(true);
    expect(await isControlledReaderEnabledForCustomer(env as any, 100)).toBe(false);
  });

  it('the global flag being on grants every customer access, regardless of the allowlist (the allowlist only ever adds, never restricts)', async () => {
    await updateSettings(env as any, logger, adminId, { controlledReaderEnabled: true }, CTX);
    expect(await isControlledReaderEnabledForCustomer(env as any, 777)).toBe(true);
  });

  it('rejects a non-array value', async () => {
    const result = await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: 'not-an-array' }, CTX);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive-integer entry (never silently coerces or drops it)', async () => {
    const result = await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [1, -5, 3] }, CTX);
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized list — this is a narrow pilot allowlist, not a rollout mechanism', async () => {
    const tooMany = Array.from({ length: 26 }, (_, i) => i + 1);
    const result = await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: tooMany }, CTX);
    expect(result.ok).toBe(false);
  });

  it('de-duplicates repeated ids rather than storing them verbatim', async () => {
    await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [5, 5, 5, 7] }, CTX);
    const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'controlled_reader_pilot_customer_ids'`).first<{ value: string }>();
    expect(JSON.parse(row!.value)).toEqual([5, 7]);
  });

  it('an empty array explicitly clears the pilot — the mechanism is fully, immediately reversible with no deploy', async () => {
    await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [42] }, CTX);
    expect(await isControlledReaderEnabledForCustomer(env as any, 42)).toBe(true);

    await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [] }, CTX);
    expect(await isControlledReaderEnabledForCustomer(env as any, 42)).toBe(false);
  });

  it('records a real audit log entry for the change, same as every other settings key', async () => {
    await updateSettings(env as any, logger, adminId, { controlledReaderPilotCustomerIds: [1] }, CTX);
    const row = await env.DB.prepare(`SELECT action FROM audit_logs WHERE actor_id = ? AND action = 'site_settings.updated' ORDER BY id DESC LIMIT 1`).bind(adminId).first<any>();
    expect(row).not.toBeNull();
  });
});
