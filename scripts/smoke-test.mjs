#!/usr/bin/env node
/**
 * Robayer WealthLab: production smoke-test suite (Version 3.6:
 * Platform Hardening, Phase 2).
 *
 * This is deliberately NOT the same thing as backend/tests/ (264
 * vitest tests, discovered during this milestone, already exercising
 * business logic against a local Miniflare D1 instance with the
 * payment provider mocked). This suite serves a different purpose:
 * fast, read-only, live-HTTP checks against the REAL deployed site,
 * codifying the manual curl/browser checks performed by hand in every
 * "stability gate" pass this project has done since Version 3.5.1 -
 * so the highest-value checks don't have to be re-derived from
 * scratch, by memory, every time.
 *
 * Every check here is read-only or a deliberately-safe negative test
 * (missing/invalid input, no auth) - nothing in this file ever
 * creates a real purchase session, sends a real email, writes a real
 * review, or mutates any admin-editable content. See "What this suite
 * intentionally does NOT cover" at the bottom of this file and in
 * docs/v3.6-regression-suite-report.md for exactly why, and what the
 * remaining manual-verification boundary is.
 *
 * No new dependency: Node's built-in `fetch` (Node 18+) is the only
 * thing this file uses.
 *
 * Usage: node scripts/smoke-test.mjs [--base=https://robayerwealthlab.com]
 */

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1] || process.env.SITE_BASE_URL || 'https://robayerwealthlab.com';

const results = [];

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - start, error: error.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'robayer-smoke-test/1.0' } });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// ---------- Phase 1: pages load (Homepage, Books, Book detail, Resources area) ----------

await check('Homepage loads', async () => {
  const res = await fetch(`${BASE}/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes('data-feature-banner'), 'Hero/Featured eBook binding markup missing');
});

await check('Books listing loads', async () => {
  const res = await fetch(`${BASE}/books/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
});

await check('Book detail page loads', async () => {
  const res = await fetch(`${BASE}/books/starting-to-invest-with-gh100/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes('data-sales-mode') && html.includes('data-owner-mode'), 'Sales/Owner mode markup missing');
});

// ---------- Featured eBook / Featured Resource (CMS-driven homepage sections) ----------

await check('Featured eBook data source (product API) responds', async () => {
  const { res, body } = await getJson('/api/products?pageSize=100');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(body?.success === true && Array.isArray(body.data?.items), 'unexpected products API shape');
});

await check('Featured Resource endpoint responds', async () => {
  const { res, body } = await getJson('/api/resources/featured');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(body?.success === true, 'unexpected featured-resource API shape');
});

// ---------- Checkout initialization (contract check only - never creates a real session) ----------

await check('Checkout session endpoint enforces its contract (no session created)', async () => {
  const res = await fetch(`${BASE}/api/checkout/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // deliberately missing required fields
  });
  const body = await res.json().catch(() => null);
  assert(res.status !== 200 || body?.success === false, 'checkout accepted an incomplete request - validation contract may be broken');
});

// ---------- Coupon application (preview endpoint, non-mutating by design) ----------

await check('Coupon validation endpoint responds to an unknown code', async () => {
  const res = await fetch(`${BASE}/api/coupons/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'SMOKE-TEST-NONEXISTENT-CODE', productSlug: 'starting-to-invest-with-gh100' }),
  });
  assert(res.status === 200 || res.status === 400 || res.status === 404, `unexpected status ${res.status}`);
  const body = await res.json().catch(() => null);
  assert(body?.success === false, 'an unknown coupon code was reported as valid');
});

// ---------- Customer auth: login, forgot password, claim purchase ----------

await check('Customer login page loads', async () => {
  const res = await fetch(`${BASE}/checkout/sign-in/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
});

await check('Forgot-password page loads', async () => {
  const res = await fetch(`${BASE}/checkout/forgot-password/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
});

await check('Claim-purchase page loads', async () => {
  const res = await fetch(`${BASE}/checkout/claim-purchase/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
});

await check('Unauthenticated session check correctly reports guest', async () => {
  const { res, body } = await getJson('/api/customer/auth/session');
  assert(res.status === 401, `expected 401 for a guest, got ${res.status}`);
  assert(body?.success === false, 'guest session check did not report failure');
});

// ---------- Dashboard / Customer Library ----------

await check('Dashboard redirects an unauthenticated visitor', async () => {
  const res = await fetch(`${BASE}/dashboard/`, { redirect: 'manual' });
  // dashboard-shell.js redirects client-side after a failed session
  // check, so the page itself still returns 200 - this check instead
  // confirms the page loads and carries the client-side auth gate,
  // which the full stability gate re-confirms behaviorally.
  assert(res.status === 200, `expected 200 (client-side redirect gate), got ${res.status}`);
  const html = await res.text();
  assert(html.includes('dashboard-shell.js'), 'dashboard auth gate script missing from the page');
});

// ---------- Review submission (auth boundary only - never posts a real review) ----------

await check('Review submission endpoint requires authentication', async () => {
  const res = await fetch(`${BASE}/api/customer/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productSlug: 'starting-to-invest-with-gh100', rating: 5, body: 'smoke test' }),
  });
  assert(res.status === 401, `expected 401 for an unauthenticated review submission, got ${res.status}`);
});

// ---------- Media loading ----------

await check('A known real media asset resolves and returns image bytes', async () => {
  const res = await fetch(`${BASE}/api/media/file/media/images/uncategorized/966b7ae9-2c3a-4281-8c45-2e5f1edc1c62.png`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  assert(contentType.startsWith('image/'), `expected an image content-type, got ${contentType}`);
});

// ---------- CMS publishing (read path only - see file header for why the write path isn't automated here) ----------

await check('Hero content CMS endpoint responds', async () => {
  const { res, body } = await getJson('/api/hero');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(body?.success === true, 'unexpected hero content API shape');
});

// ---------- Executive Dashboard / Health endpoints (existence + auth-gating only) ----------

await check('Admin login page loads', async () => {
  const res = await fetch(`${BASE}/admin/login/`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
});

await check('Admin dashboard health endpoint requires authentication', async () => {
  const res = await fetch(`${BASE}/api/admin/dashboard/health`);
  assert(res.status === 401, `expected 401 for an unauthenticated health check, got ${res.status}`);
});

// ---------- Phase 9C.10: EPUB reader layout fix (blank content area) ----------
// Guards the exact regression: `.reader-canvas-wrap`'s height was `auto`
// (only `max-height` was set), which epub.js's `height: 100%` iframe sizing
// can't resolve against - the iframe rendered with real chapter content
// already inside it, but a 0px box. `.reader-canvas-wrap--epub` (a real,
// non-`max-` `height`) and cleanupDuplicateEpubContainers() (removing the
// stale, wrongly-sized `.epub-container` this vendored epub.js build can
// leave behind) are what fixed it - both re-checked here against the
// REAL deployed files, not local source, since "committed" and "actually
// live" have differed before (see Phase 9C.6-9C.9's own history).

// Reads the reader page itself for the CURRENT `?v=` hash on each asset,
// rather than checking the bare/unversioned URL - the bare URL is never
// what a real browser loads (dashboard/read/index.html always references
// the versioned one; see scripts/bump-asset-versions.mjs) and can sit on
// a stale CDN-cached response indefinitely even after a fix that changed
// its content has shipped and its hash has moved on.
async function currentAssetUrl(assetPath) {
  const res = await fetch(`${BASE}/dashboard/read/`);
  const html = await res.text();
  const escaped = assetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`${escaped}(\\?v=[a-zA-Z0-9]+)?`));
  assert(match, `${assetPath} not referenced by dashboard/read/`);
  return `${BASE}${assetPath}${match[1] || ''}`;
}

await check('Reader CSS: .reader-canvas-wrap--epub sets a real height, not just max-height', async () => {
  const url = await currentAssetUrl('/css/components.css');
  const res = await fetch(url);
  assert(res.status === 200, `expected 200 for ${url}, got ${res.status}`);
  const css = await res.text();
  const match = css.match(/\.reader-canvas-wrap--epub\s*\{([^}]*)\}/);
  assert(match, `.reader-canvas-wrap--epub rule not found in deployed components.css (${url})`);
  assert(/(?<!max-)height\s*:\s*\d/.test(match[1]), '.reader-canvas-wrap--epub has no real (non-max-) height declaration');
});

await check('Reader JS: duplicate-.epub-container cleanup is present and wired to the "rendered" event', async () => {
  const url = await currentAssetUrl('/js/components/library-reader.js');
  const res = await fetch(url);
  assert(res.status === 200, `expected 200 for ${url}, got ${res.status}`);
  const js = await res.text();
  assert(js.includes('cleanupDuplicateEpubContainers'), `cleanupDuplicateEpubContainers() missing from deployed library-reader.js (${url})`);
  assert(/\.on\(\s*['"]rendered['"]\s*,\s*cleanupDuplicateEpubContainers/.test(js), 'cleanup is not wired to epub.js\'s "rendered" event');
  assert(js.includes('reader-canvas-wrap--epub'), 'reader-canvas-wrap--epub class toggle missing from deployed library-reader.js');
});

await check('Product-agnostic: at least two different products\' catalog entries list a real EPUB file', async () => {
  const slugs = ['starting-to-invest-with-gh100', 'treasury-bills-made-simple'];
  let epubCount = 0;
  for (const slug of slugs) {
    const { res, body } = await getJson(`/api/products/${slug}`);
    assert(res.status === 200, `expected 200 for ${slug}, got ${res.status}`);
    if (Array.isArray(body?.data?.files) && body.data.files.some((f) => f.fileType === 'EPUB')) epubCount += 1;
  }
  assert(epubCount >= 2, `expected at least 2 of ${slugs.length} test products to list an EPUB file, found ${epubCount}`);
});

// ---------- Report ----------

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)${r.ok ? '' : ` — ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed against ${BASE}`);
if (failed.length > 0) process.exit(1);

/**
 * What this suite intentionally does NOT cover, and why:
 *
 * - Actually completing a checkout / creating a real purchase_sessions
 *   row: would pollute production with abandoned test transactions on
 *   every run. Covered instead by backend/tests/integration/checkout.test.ts
 *   and webhook.test.ts against a local, mocked-provider Miniflare
 *   instance.
 * - Actually applying a coupon to a real order, actually logging in,
 *   actually resetting a password, actually submitting a review:  same
 *   reasoning - each would either require a real password (this
 *   project's own standing rule against ever entering one into an
 *   automated script) or would send a real email / write real data on
 *   every run.
 * - Live CMS-edit-and-propagation (the "does this book detail page
 *   update within seconds of an admin save" check): requires a real
 *   admin session and a real content mutation. Performed manually,
 *   with a real edit/revert cycle, at the start of every milestone
 *   (see the various *-stability-gate and *-verification reports) -
 *   deliberately not automated into an unattended script that would
 *   otherwise need long-lived admin credentials committed somewhere.
 * - Executive Dashboard's actual KPI numbers: would also require a
 *   real admin session. This suite only confirms the endpoint exists
 *   and is correctly gated; a human re-checks the numbers themselves
 *   look real during each milestone's manual verification pass.
 * - Visual/CSS regressions, responsive layout, dark mode: this suite
 *   is HTTP/JSON-shape only, no browser. Covered by the manual
 *   browser-based checks in each milestone's Regression/Verification
 *   Report.
 */
