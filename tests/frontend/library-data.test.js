/**
 * Phase J.2.3 regression tests — js/components/library-data.js, the
 * shared client-side cache the J.1 audit's Performance finding called
 * for: GET /api/customer/purchases was independently fetched by up to
 * four Library-home components, GET /api/customer/library/progress by
 * up to three, on every single Library page load.
 *
 * Same technique as library-ai-panel.citations.test.js — Node's built-in
 * test runner + `node:vm` executing the real, unmodified source file
 * (no new framework/dependency for one small module). library-data.js
 * has no DOM dependency at all, only `window.CustomerDashboard.customerFetch`,
 * so the sandbox only needs that one stub.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLibraryData(customerFetch) {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/library-data.js'), 'utf8');
  const sandbox = { window: { CustomerDashboard: { customerFetch } } };
  sandbox.window.window = sandbox.window; // some callers may reference window.window; harmless either way
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'library-data.js' });
  return sandbox.window.LibraryData;
}

test('getPurchases() called twice in one page load issues exactly one underlying fetch', async () => {
  let calls = 0;
  const LibraryData = loadLibraryData((url) => {
    calls += 1;
    assert.equal(url, '/api/customer/purchases?limit=50');
    return Promise.resolve({ purchases: [{ purchaseReference: 'RWL-2026-000001' }] });
  });

  const [first, second] = await Promise.all([LibraryData.getPurchases(), LibraryData.getPurchases()]);
  assert.equal(calls, 1, 'a second caller in the same load must reuse the first in-flight request, not issue a new one');
  assert.deepEqual(first, second);

  // A third call after both have resolved must still reuse the cached result.
  const third = await LibraryData.getPurchases();
  assert.equal(calls, 1);
  assert.deepEqual(third, first);
});

test('getProgress() called three times (matching library-continue-reading.js, library-ai-entry.js, library-list.js) issues exactly one underlying fetch', async () => {
  let calls = 0;
  const LibraryData = loadLibraryData((url) => {
    if (url === '/api/customer/library/progress') calls += 1;
    return Promise.resolve({ progress: [] });
  });

  await Promise.all([LibraryData.getProgress(), LibraryData.getProgress(), LibraryData.getProgress()]);
  assert.equal(calls, 1);
});

test('a failed fetch is not cached as a failure — the next call genuinely retries', async () => {
  let calls = 0;
  const LibraryData = loadLibraryData(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('network error'));
    return Promise.resolve({ purchases: [] });
  });

  await assert.rejects(() => LibraryData.getPurchases());
  assert.equal(calls, 1);

  const result = await LibraryData.getPurchases();
  assert.equal(calls, 2, 'a call after a failure must genuinely re-fetch, not reuse the rejected promise');
  assert.deepEqual(result, { purchases: [] });
});

test('invalidatePurchases()/invalidateProgress() force the next call to genuinely re-fetch', async () => {
  let calls = 0;
  const LibraryData = loadLibraryData(() => {
    calls += 1;
    return Promise.resolve({ purchases: [], progress: [] });
  });

  await LibraryData.getPurchases();
  await LibraryData.getPurchases();
  assert.equal(calls, 1);

  LibraryData.invalidatePurchases();
  await LibraryData.getPurchases();
  assert.equal(calls, 2, 'invalidatePurchases() must force a genuine re-fetch on the next call');
});

test('purchases and progress are cached independently — invalidating one never affects the other', async () => {
  let purchaseCalls = 0;
  let progressCalls = 0;
  const LibraryData = loadLibraryData((url) => {
    if (url.startsWith('/api/customer/purchases')) purchaseCalls += 1;
    else progressCalls += 1;
    return Promise.resolve({});
  });

  await Promise.all([LibraryData.getPurchases(), LibraryData.getProgress()]);
  LibraryData.invalidatePurchases();
  await LibraryData.getPurchases();

  assert.equal(purchaseCalls, 2);
  assert.equal(progressCalls, 1, 'invalidating purchases must not force a redundant progress re-fetch');
});
