/**
 * Regression tests: js/components/affiliate-resources.js (Phase 2E).
 * Same node:vm-execution technique as affiliate-links.test.js: the
 * real, unmodified source files are executed in a minimal sandbox
 * (affiliate-shared.js loaded first, exactly matching script order on
 * affiliate/resources/index.html) and top-level functions are called
 * directly.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAffiliateResourcesSandbox() {
  const sharedSource = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-shared.js'), 'utf8');
  const resourcesSource = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-resources.js'), 'utf8');
  const sandbox = {
    window: { location: { origin: 'https://robayerwealthlab.com' } },
    document: {
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => ({ style: {}, addEventListener: () => {}, remove: () => {} }),
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => {},
    },
    navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedSource, sandbox, { filename: 'affiliate-shared.js' });
  vm.runInContext(resourcesSource, sandbox, { filename: 'affiliate-resources.js' });
  return sandbox;
}

/** A minimal fake DOM element that tracks textContent, className, and setAttribute() calls, and can hold appended children — just enough to exercise renderFilterPills() end to end. */
function fakeElement() {
  const el = { className: '', textContent: '', attributes: {}, children: [] };
  el.setAttribute = (name, value) => { el.attributes[name] = value; };
  el.appendChild = (child) => { el.children.push(child); };
  return el;
}

function loadAffiliateResourcesSandboxWithFakeDom() {
  const sharedSource = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-shared.js'), 'utf8');
  const resourcesSource = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-resources.js'), 'utf8');
  const sandbox = {
    window: { location: { origin: 'https://robayerwealthlab.com' } },
    document: {
      querySelector: () => null,
      addEventListener: () => {},
      createElement: fakeElement,
      body: { appendChild: () => {}, removeChild: () => {} },
      execCommand: () => {},
    },
    navigator: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedSource, sandbox, { filename: 'affiliate-shared.js' });
  vm.runInContext(resourcesSource, sandbox, { filename: 'affiliate-resources.js' });
  return sandbox;
}

test('personalize() substitutes {{link}} with this affiliate\'s real referral URL for the resource\'s product', () => {
  const sandbox = loadAffiliateResourcesSandbox();
  const result = sandbox.personalize('Check it out here: {{link}}', 'RWLROBERT', 'treasury-bills-made-simple');
  assert.equal(result, 'Check it out here: https://robayerwealthlab.com/books/treasury-bills-made-simple/?ref=RWLROBERT');
});

test('personalize() falls back to the homepage destination when a resource has no product_slug', () => {
  const sandbox = loadAffiliateResourcesSandbox();
  const result = sandbox.personalize('Share this: {{link}}', 'RWLROBERT', null);
  assert.equal(result, 'Share this: https://robayerwealthlab.com/?ref=RWLROBERT');
});

test('personalize() substitutes every occurrence of the token, not just the first', () => {
  const sandbox = loadAffiliateResourcesSandbox();
  const result = sandbox.personalize('{{link}} and again {{link}}', 'RWLROBERT', 'homepage');
  const expected = 'https://robayerwealthlab.com/?ref=RWLROBERT and again https://robayerwealthlab.com/?ref=RWLROBERT';
  assert.equal(result, expected);
});

test('personalize() leaves a body with no {{link}} token unchanged', () => {
  const sandbox = loadAffiliateResourcesSandbox();
  const result = sandbox.personalize('No token here at all.', 'RWLROBERT', 'homepage');
  assert.equal(result, 'No token here at all.');
});

test('personalize() returns a falsy body unchanged (no crash on a null/empty resource body)', () => {
  const sandbox = loadAffiliateResourcesSandbox();
  assert.equal(sandbox.personalize(null, 'RWLROBERT', 'homepage'), null);
  assert.equal(sandbox.personalize('', 'RWLROBERT', 'homepage'), '');
});

test('renderFilterPills() labels each product pill with its real title, never "[object Object]" (Map.forEach callback order regression)', () => {
  const sandbox = loadAffiliateResourcesSandboxWithFakeDom();
  const container = fakeElement();
  const groups = new Map();
  groups.set('treasury-bills-made-simple', [{ id: 1 }, { id: 2 }]);
  groups.set('understanding-the-ghana-stock-exchange', [{ id: 3 }]);
  const products = [
    { slug: 'treasury-bills-made-simple', title: 'Treasury Bills Made Simple' },
    { slug: 'understanding-the-ghana-stock-exchange', title: 'Understanding the Ghana Stock Exchange' },
  ];
  sandbox.window.RobayerProducts = {
    getBySlug: (list, slug) => (list || []).find((p) => p.slug === slug) || null,
  };

  sandbox.renderFilterPills(container, groups, products);

  const labels = container.children.map((pill) => pill.textContent);
  assert.deepEqual(labels, ['All', 'Treasury Bills Made Simple', 'Understanding the Ghana Stock Exchange']);
  labels.forEach((label) => assert.doesNotMatch(label, /\[object Object\]/));
});

test('personalize() never hardcodes any specific affiliate code: the code is always a parameter, never a literal in the source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-resources.js'), 'utf8');
  assert.match(source, /function personalize\(body, affiliateCode, productSlug\)/);
  // No literal RWL-prefixed code embedded anywhere in the component itself.
  assert.doesNotMatch(source, /['"]RWL[A-Z0-9]+['"]/);
});
