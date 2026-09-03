/**
 * Regression tests: js/components/dashboard-shell.js's optional-auth
 * routing (the fix for the production regression where
 * partials/affiliate-nav.html carried `data-optional-auth` directly,
 * silently switching affiliate/links/, affiliate/resources/, and
 * affiliate/earnings/ over to the non-redirecting guest path too, since
 * that nav is one shared partial included by all four /affiliate/*
 * pages). The fix reads the flag from each page's own `document.body`
 * instead, so only a page that explicitly opts in is affected.
 *
 * Same node:vm-execution technique as affiliate-links.test.js: the
 * real, unmodified source file is executed in a minimal sandbox.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDashboardShellSandbox({ optionalAuth, sessionOrNull, requireSessionResult }) {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/dashboard-shell.js'), 'utf8');

  const navEl = {
    hidden: false,
    attrs: {},
    hasAttribute(name) { return name in this.attrs; },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
  const bodyEl = {
    attrs: optionalAuth ? { 'data-optional-auth': '' } : {},
    hasAttribute(name) { return name in this.attrs; },
  };
  const calls = { requireSession: 0, getSessionOrNull: 0 };
  const dispatched = [];
  const handlers = {};

  const sandbox = {
    window: {
      location: { pathname: '/affiliate/', origin: 'https://robayerwealthlab.com' },
      CustomerDashboard: {
        requireSession: async () => {
          calls.requireSession += 1;
          return requireSessionResult;
        },
        getSessionOrNull: async () => {
          calls.getSessionOrNull += 1;
          return sessionOrNull;
        },
        logout: async () => {},
      },
    },
    document: {
      body: bodyEl,
      querySelector: (selector) => (selector === '.dashboard-nav' ? navEl : null),
      querySelectorAll: () => [],
      addEventListener: (type, handler) => {
        handlers[type] = handler;
      },
      dispatchEvent: (event) => {
        dispatched.push(event.type);
      },
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    URL: URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'dashboard-shell.js' });
  return { handlers, navEl, calls, dispatched };
}

test('a page whose body carries data-optional-auth with no session takes the guest path: getSessionOrNull() is used, requireSession() is never called, dashboard:guest fires, nav is hidden', async () => {
  const { handlers, navEl, calls, dispatched } = loadDashboardShellSandbox({ optionalAuth: true, sessionOrNull: null });
  await handlers['partials:loaded']();
  assert.equal(calls.getSessionOrNull, 1);
  assert.equal(calls.requireSession, 0);
  assert.deepEqual(dispatched, ['dashboard:guest']);
  assert.equal(navEl.hidden, true);
});

test('a page whose body carries data-optional-auth WITH a real session behaves like every other authenticated page: dashboard:ready fires, not dashboard:guest', async () => {
  const { handlers, calls, dispatched } = loadDashboardShellSandbox({ optionalAuth: true, sessionOrNull: { email: 'affiliate@example.com' } });
  await handlers['partials:loaded']();
  assert.equal(calls.getSessionOrNull, 1);
  assert.equal(calls.requireSession, 0);
  assert.deepEqual(dispatched, ['dashboard:ready']);
});

test('a page whose body does NOT carry data-optional-auth (affiliate/links/, affiliate/resources/, affiliate/earnings/) always uses requireSession(), never getSessionOrNull(): the exact regression this test guards against was these pages silently taking the guest path and hanging on "Loading..." instead of redirecting to sign-in', async () => {
  const { handlers, calls, dispatched } = loadDashboardShellSandbox({ optionalAuth: false, requireSessionResult: { email: 'affiliate@example.com' } });
  await handlers['partials:loaded']();
  assert.equal(calls.requireSession, 1);
  assert.equal(calls.getSessionOrNull, 0);
  assert.deepEqual(dispatched, ['dashboard:ready']);
});

test('structural guard: the shared affiliate-nav.html partial never carries data-optional-auth again (that is what caused the regression: one shared include silently affecting all four pages)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../partials/affiliate-nav.html'), 'utf8');
  assert.doesNotMatch(source, /data-optional-auth/);
});

test('structural guard: exactly one of the four /affiliate/* pages has data-optional-auth on its own <body>, and it is affiliate/index.html', () => {
  const pages = {
    'affiliate/index.html': true,
    'affiliate/links/index.html': false,
    'affiliate/resources/index.html': false,
    'affiliate/earnings/index.html': false,
  };
  for (const [relPath, shouldHaveFlag] of Object.entries(pages)) {
    const source = fs.readFileSync(path.join(__dirname, '../../', relPath), 'utf8');
    const bodyTagMatch = source.match(/<body[^>]*>/);
    assert.ok(bodyTagMatch, `${relPath} has a <body> tag`);
    const hasFlag = /data-optional-auth/.test(bodyTagMatch[0]);
    assert.equal(hasFlag, shouldHaveFlag, `${relPath}'s <body> tag data-optional-auth presence`);
  }
});
