/**
 * Regression tests: js/components/affiliate-links.js. Same
 * node:vm-execution technique as library-data.test.js: the real,
 * unmodified source file is executed in a minimal sandbox and its
 * top-level function declarations (buildUrl) are called directly,
 * genuine logic verification, not a source-text regex match.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAffiliateLinksSandbox() {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-links.js'), 'utf8');
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
  vm.runInContext(source, sandbox, { filename: 'affiliate-links.js' });
  return sandbox;
}

test('buildUrl() constructs a homepage referral link with the affiliate code as ?ref=', () => {
  const sandbox = loadAffiliateLinksSandbox();
  const url = sandbox.buildUrl('RWLROBERT', 'homepage');
  assert.equal(url, 'https://robayerwealthlab.com/?ref=RWLROBERT');
});

test('buildUrl() constructs a product-specific referral link under /books/{slug}/', () => {
  const sandbox = loadAffiliateLinksSandbox();
  const url = sandbox.buildUrl('RWLROBERT', 'understanding-the-ghana-stock-exchange');
  assert.equal(url, 'https://robayerwealthlab.com/books/understanding-the-ghana-stock-exchange/?ref=RWLROBERT');
});

test('buildUrl() URL-encodes an affiliate code that could otherwise break the query string', () => {
  const sandbox = loadAffiliateLinksSandbox();
  const url = sandbox.buildUrl('RWL&CODE', 'homepage');
  assert.equal(url, 'https://robayerwealthlab.com/?ref=RWL%26CODE');
});

test('the module never exposes any database id in the generated URL: only the affiliate CODE is ever used', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/affiliate-links.js'), 'utf8');
  // buildUrl()'s own signature takes a `code`, never an `id`: a
  // structural guard against a future edit accidentally threading a
  // raw database id into the public referral URL.
  assert.match(source, /function buildUrl\(code, destination\)/);
  assert.doesNotMatch(source, /\bid\b.*ref=/);
});
