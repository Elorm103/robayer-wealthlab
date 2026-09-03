/**
 * Regression tests: js/main.js's trackAffiliateReferral() (Affiliate
 * Programme, referral-click detection). Executes the real,
 * unmodified source file via node:vm with a stubbed window/document/
 * fetch, exactly like library-data.test.js's technique: genuine
 * behavior verification (the real fetch call this function makes),
 * not a source-text regex match.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runMainJs({ search, pathname, fetchImpl }) {
  const source = fs.readFileSync(path.join(__dirname, '../../js/main.js'), 'utf8');
  const listeners = {};
  const sandbox = {
    window: { location: { search, pathname } },
    document: {
      addEventListener: (event, handler) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      getElementById: () => null,
    },
    fetch: fetchImpl,
    URLSearchParams: URLSearchParams,
    console: { warn: () => {} },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'main.js' });
  return { sandbox, listeners };
}

test('a page load with ?ref= posts to /api/affiliates/click with the code and landing path', async () => {
  let capturedUrl, capturedBody;
  const fetchImpl = (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return Promise.resolve({ ok: true });
  };

  runMainJs({ search: '?ref=RWLROBERT', pathname: '/', fetchImpl });

  assert.equal(capturedUrl, '/api/affiliates/click');
  assert.equal(capturedBody.code, 'RWLROBERT');
  assert.equal(capturedBody.productSlug, null);
  assert.equal(capturedBody.landingPath, '/');
});

test('a page load with no ?ref= parameter never calls the click-tracking endpoint at all', () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    return Promise.resolve({ ok: true });
  };

  runMainJs({ search: '', pathname: '/', fetchImpl });

  assert.equal(called, false, 'no ?ref= present must be a complete no-op: no network call at all');
});

test('a referral click on a /books/{slug}/ page carries that product slug for product-specific attribution', async () => {
  let capturedBody;
  const fetchImpl = (url, options) => {
    capturedBody = JSON.parse(options.body);
    return Promise.resolve({ ok: true });
  };

  runMainJs({ search: '?ref=RWLROBERT', pathname: '/books/understanding-the-ghana-stock-exchange/', fetchImpl });

  assert.equal(capturedBody.productSlug, 'understanding-the-ghana-stock-exchange');
});

test('a rejected/failing fetch never throws back into page load (silent, deliberate)', async () => {
  const fetchImpl = () => Promise.reject(new Error('network down'));
  assert.doesNotThrow(() => runMainJs({ search: '?ref=RWLROBERT', pathname: '/', fetchImpl }));
});
