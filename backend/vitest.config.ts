/**
 * Test configuration — Version 3.0.2 Milestone M1 (Customer Identity &
 * Guest Checkout). This project had no automated test suite before
 * this milestone (confirmed: no vitest config, no test files, no test
 * script existed anywhere in the repo) — see
 * docs/v3.0.2-arb-review-report.md's own finding on this. Uses
 * @cloudflare/vitest-pool-workers, the Cloudflare-maintained test
 * runner for Workers projects: tests run inside the actual workerd
 * runtime with real D1/KV bindings, not a Node.js approximation of one.
 *
 * `cloudflareTest()` (a Vite plugin, not the older `defineWorkersConfig`
 * wrapper — that API was removed in @cloudflare/vitest-pool-workers'
 * vitest-4-compatible release, confirmed directly against the
 * installed package's own exports rather than assumed) is passed an
 * async factory so `readD1Migrations()` can resolve before the pool
 * options are built.
 *
 * D1 migrations are read from the same database/migrations/ directory
 * wrangler.jsonc's own `migrations_dir` already points to.
 *
 * `htmlAsTextPlugin` — wrangler.jsonc's own `rules: [{ type: "Text",
 * globs: ["**\/*.html"] }]` tells *wrangler's* bundler to import every
 * `.html` file (the email templates services/emailService.ts pulls in)
 * as a raw string. Vite (what @cloudflare/vitest-pool-workers actually
 * uses to build the worker-under-test) has no knowledge of that rule —
 * without this, loading worker/index.ts for SELF.fetch() crashes at
 * import time. Confirmed directly: a minimal SELF.fetch('/api/health')
 * test failed identically until this was added, and passed cleanly
 * once it was.
 *
 * `outboundService: outboundMock` intercepts every outbound fetch() the
 * worker-under-test makes (Paystack, Resend) with a plain JS function —
 * see tests/outboundMock.ts's own header comment for why this, and not
 * undici's MockAgent (crashes the test worker in this sandbox) or a
 * real local HTTP server (blocked by workerd's default SSRF network
 * policy, which denies outbound connections to loopback/private
 * addresses even in local dev). Because outboundService intercepts
 * *before* workerd's network layer is ever involved, PAYSTACK_BASE_URL
 * and RESEND_BASE_URL are left at their real wrangler.jsonc values —
 * no test-only URL override needed. `test.fileParallelism: false` is
 * kept because outboundMock.ts's handler state (setInitializeHandler
 * etc.) is shared, in-process, module-level state across the whole
 * test run — concurrent test files would otherwise race on it.
 */
import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { outboundMock } from './tests/outboundMock';

function htmlAsTextPlugin(): Plugin {
  return {
    name: 'html-as-text',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.html')) return null;
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

export default defineConfig({
  test: {
    setupFiles: ['./tests/apply-migrations.ts'],
    fileParallelism: false,
  },
  plugins: [
    htmlAsTextPlugin(),
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, 'database/migrations'));
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
          },
          outboundService: outboundMock,
        },
      };
    }),
  ],
});
