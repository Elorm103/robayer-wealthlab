/**
 * Runs once before the test suite — applies every migration in
 * database/migrations/ to the isolated test D1 instance. See
 * vitest.config.ts's own comment for why this is the right source of
 * schema truth (the same migrations the real database was built from).
 */
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Test-infrastructure-only table — the cross-boundary channel
// tests/outboundMock.ts uses to pass mock provider responses from test
// files (running inside the worker) to the outboundService function
// (running in the host process). Never part of the real product
// schema — see outboundMock.ts's header comment for why this exists.
await env.DB.exec('CREATE TABLE IF NOT EXISTS test_mock_responses (key TEXT PRIMARY KEY, response TEXT NOT NULL)');
