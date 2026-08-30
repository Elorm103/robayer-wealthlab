/**
 * Phase J.0.2 regression tests — js/components/admin/admin-reset-password.js.
 *
 * The production defect: admin/reset-password/index.html deliberately
 * places its error/success <p> elements as SIBLINGS of <form> (the
 * success path does `form.hidden = true` then reveals successEl — that
 * only works if successEl is not itself inside the now-hidden form).
 * The JS queried both via `form.querySelector(...)`, which only finds
 * descendants — so both were silently null, and clicking "Reset
 * password" threw `TypeError: Cannot set properties of null` inside
 * hideError() before the network request was ever sent. Confirmed live
 * against production before the fix (no POST request in the network
 * log for the click) and against the fixed code locally (see the J.0.2
 * report) — this file is the permanent, automated guard against that
 * exact regression class recurring silently.
 *
 * Same technique as tests/frontend/library-ai-panel.citations.test.js:
 * Node's built-in test runner + a small, purpose-built DOM stub (not
 * jsdom — this project has no frontend test framework and none is
 * being introduced for one small form) sufficient to run the REAL,
 * unmodified admin-reset-password.js end to end.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Minimal DOM element: attribute/dataset lookups, the few properties this file reads/writes, and a tree walk sufficient for querySelector. */
function makeElement(tag, attrs = {}) {
  return {
    tag,
    attrs: { ...attrs },
    children: [],
    hidden: false,
    disabled: false,
    textContent: '',
    value: attrs.value ?? '',
    listeners: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return name in this.attrs; },
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    querySelector(selector) { return queryTree(this, selector, false); },
    querySelectorAll(selector) { return queryTree(this, selector, true) || []; },
  };
}

function matches(el, selector) {
  if (selector.startsWith('#')) return el.attrs.id === selector.slice(1);
  if (selector.startsWith('[') && selector.endsWith(']')) return el.hasAttribute(selector.slice(1, -1));
  const m = selector.match(/^([a-z0-9]+)\[type="([^"]+)"\]$/i);
  if (m) return el.tag === m[1] && el.attrs.type === m[2];
  return el.tag === selector;
}

function queryTree(root, selector, all) {
  const found = [];
  (function walk(el) {
    for (const child of el.children) {
      if (matches(child, selector)) {
        if (!all) { found.push(child); return; }
        found.push(child);
      }
      if (!all && found.length) return;
      walk(child);
    }
  })(root);
  return all ? found : found[0] || null;
}

/**
 * Builds the exact real DOM shape from admin/reset-password/index.html
 * (post-fix): error/success <p> elements as siblings of <form>, both
 * children of a shared parent — never descendants of the form.
 */
function buildRealPageDom() {
  const errorEl = makeElement('p', { 'data-admin-reset-error': '' });
  errorEl.hidden = true;
  const successEl = makeElement('p', { 'data-admin-reset-success': '' });
  successEl.hidden = true;
  successEl.textContent = 'Your password has been reset. You can now sign in.';

  const passwordInput = makeElement('input', { id: 'admin-reset-password', type: 'password' });
  const confirmInput = makeElement('input', { id: 'admin-reset-password-confirm', type: 'password' });
  const submitButton = makeElement('button', { type: 'submit' });
  submitButton.textContent = 'Reset password';

  const form = makeElement('form', { 'data-admin-reset-form': '' });
  form.children = [passwordInput, confirmInput, submitButton];

  const card = makeElement('div');
  card.children = [errorEl, successEl, form]; // real DOM order: siblings, form last

  const document = {
    _root: card,
    querySelector(selector) { return queryTree(this._root, selector, false); },
    querySelectorAll(selector) { return queryTree(this._root, selector, true) || []; },
    addEventListener() {}, // DOMContentLoaded — the harness calls initAdminResetPassword() directly instead
  };

  return { document, errorEl, successEl, passwordInput, confirmInput, submitButton, form };
}

function loadInitFunction(sandbox) {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/admin/admin-reset-password.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'admin-reset-password.js' });
  return sandbox.initAdminResetPassword;
}

async function submitForm(form) {
  const handlers = form.listeners.submit || [];
  const event = { preventDefault() {} };
  for (const handler of handlers) await handler(event);
}

test('a real, well-formed submit reaches adminFetch without throwing (the exact regression: it previously threw before ever calling fetch)', async () => {
  const dom = buildRealPageDom();
  let fetchCalled = false;
  let fetchBody = null;
  const sandbox = {
    document: dom.document,
    window: {
      location: { search: '?token=real-token-shape-1234567890abcdef' },
      AdminAuth: {
        adminFetch: async (url, options) => {
          fetchCalled = true;
          fetchBody = JSON.parse(options.body);
          return { adminId: 1 };
        },
      },
      setTimeout: () => {},
    },
  };
  sandbox.URLSearchParams = URLSearchParams;
  const init = loadInitFunction(sandbox);

  init();
  dom.passwordInput.value = 'a-genuinely-strong-password-12';
  dom.confirmInput.value = 'a-genuinely-strong-password-12';

  await submitForm(dom.form);

  assert.equal(fetchCalled, true, 'the fetch to /api/admin/auth/reset-password must actually be attempted');
  assert.equal(fetchBody.token, 'real-token-shape-1234567890abcdef');
  assert.equal(fetchBody.newPassword, 'a-genuinely-strong-password-12');
});

test('mismatched passwords are rejected client-side, with no network request sent', async () => {
  const dom = buildRealPageDom();
  let fetchCalled = false;
  const sandbox = {
    document: dom.document,
    window: {
      location: { search: '?token=real-token-shape-1234567890abcdef' },
      AdminAuth: { adminFetch: async () => { fetchCalled = true; return {}; } },
      setTimeout: () => {},
    },
  };
  sandbox.URLSearchParams = URLSearchParams;
  const init = loadInitFunction(sandbox);

  init();
  dom.passwordInput.value = 'a-genuinely-strong-password-12';
  dom.confirmInput.value = 'a-different-password-entirely';

  await submitForm(dom.form);

  assert.equal(fetchCalled, false);
  assert.equal(dom.errorEl.hidden, false, 'the error element must actually become visible — this is exactly what was broken (it was null)');
  assert.equal(dom.errorEl.textContent, 'Passwords do not match.');
});

test('a backend error surfaces a real, visible message and re-enables the button (never a silent no-op)', async () => {
  const dom = buildRealPageDom();
  const sandbox = {
    document: dom.document,
    window: {
      location: { search: '?token=real-token-shape-1234567890abcdef' },
      AdminAuth: {
        adminFetch: async () => {
          const err = new Error('This reset link is invalid or has expired. Please request a new one.');
          throw err;
        },
      },
      setTimeout: () => {},
    },
  };
  sandbox.URLSearchParams = URLSearchParams;
  const init = loadInitFunction(sandbox);

  init();
  dom.passwordInput.value = 'a-genuinely-strong-password-12';
  dom.confirmInput.value = 'a-genuinely-strong-password-12';

  await submitForm(dom.form);

  assert.equal(dom.errorEl.hidden, false);
  assert.equal(dom.errorEl.textContent, 'This reset link is invalid or has expired. Please request a new one.');
  assert.equal(dom.submitButton.disabled, false, 'the button must be re-enabled after a failure, not left stuck');
});

test('a successful reset hides the form and reveals a real, visible success message, then schedules a redirect to /admin/login/', async () => {
  const dom = buildRealPageDom();
  let redirectScheduled = null;
  const sandbox = {
    document: dom.document,
    window: {
      location: { search: '?token=real-token-shape-1234567890abcdef', href: '' },
      AdminAuth: { adminFetch: async () => ({ adminId: 1 }) },
      setTimeout: (fn) => { redirectScheduled = fn; },
    },
  };
  sandbox.URLSearchParams = URLSearchParams;
  const init = loadInitFunction(sandbox);

  init();
  dom.passwordInput.value = 'a-genuinely-strong-password-12';
  dom.confirmInput.value = 'a-genuinely-strong-password-12';

  await submitForm(dom.form);

  assert.equal(dom.form.hidden, true);
  assert.equal(dom.successEl.hidden, false, 'the success element must actually become visible — this is exactly what was broken (it was null)');
  assert.ok(typeof redirectScheduled === 'function', 'a redirect must be scheduled after success');

  redirectScheduled();
  assert.equal(sandbox.window.location.href, '/admin/login/');
});

test('a missing token disables the button and shows a real error immediately, without ever touching the DOM elements the original bug crashed on', () => {
  const dom = buildRealPageDom();
  const sandbox = {
    document: dom.document,
    window: { location: { search: '' }, AdminAuth: { adminFetch: async () => ({}) }, setTimeout: () => {} },
  };
  sandbox.URLSearchParams = URLSearchParams;
  const init = loadInitFunction(sandbox);

  assert.doesNotThrow(() => init());
  assert.equal(dom.submitButton.disabled, true);
  assert.equal(dom.errorEl.hidden, false);
  assert.match(dom.errorEl.textContent, /missing its token/);
});
