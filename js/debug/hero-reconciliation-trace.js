/**
 * TEMPORARY — Version 4.2.7 Final Acceptance Audit. Diagnostic only:
 * MutationObserver logging on the homepage's server-rendered hero
 * elements. No behavior change. Remove this file and its <script> tag
 * once the audit is complete.
 */
(function () {
  // Set here rather than via a separate inline <script> tag - this
  // site's CSP is script-src 'self' with no 'unsafe-inline', which
  // silently blocks inline scripts (confirmed: the earlier inline-tag
  // version of this flag never actually set window.__RECON_AUDIT__).
  // This file is loaded via <script src>, which satisfies 'self'.
  window.__RECON_AUDIT__ = true;

  function log(label, extra) {
    var line = '[RECON-TRACE] ' + performance.now().toFixed(2) + 'ms  ' + label;
    if (extra !== undefined) {
      try { line += '  ' + JSON.stringify(extra); } catch (e) { line += '  ' + String(extra); }
    }
    console.log(line);
  }

  log('script-start', { readyState: document.readyState });
  document.addEventListener('DOMContentLoaded', function () { log('DOMContentLoaded'); });
  window.addEventListener('load', function () { log('window.load'); });

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) { log('paint:' + e.name, { startTime: e.startTime }); });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        log('LCP-candidate', { startTime: e.startTime, url: e.url || null, elementClass: e.element ? e.element.className : null });
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}

  var SELECTORS = [
    '.hero__visual',
    '.hero__visual-link',
    '.book-card__cover-image',
    '[data-feature-title]',
    '[data-feature-subtitle]',
    '.hero__book-cta[data-feature-cta-label]',
    '[data-feature-placeholder]',
  ];

  function snapshot(el) {
    return {
      tag: el.tagName,
      className: el.className,
      hidden: el.hidden,
      src: el.getAttribute ? el.getAttribute('src') : undefined,
      text: el.textContent ? el.textContent.trim().slice(0, 80) : null,
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    log('--- attaching MutationObservers (Phase 1) ---');
    var seen = new WeakSet();
    SELECTORS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el, i) {
        if (seen.has(el)) return;
        seen.add(el);
        log('observed at DCL: ' + sel + '[' + i + ']', snapshot(el));
        var mo = new MutationObserver(function (mutations) {
          mutations.forEach(function (m) {
            var detail = { type: m.type };
            if (m.type === 'attributes') {
              detail.attributeName = m.attributeName;
              detail.oldValue = m.oldValue;
              detail.now = snapshot(el);
            } else if (m.type === 'characterData' || m.type === 'childList') {
              detail.now = snapshot(el);
              detail.addedNodes = m.addedNodes.length;
              detail.removedNodes = m.removedNodes.length;
            }
            log('MUTATION ' + sel + '[' + i + ']', detail);
          });
        });
        mo.observe(el, {
          attributes: true, attributeOldValue: true,
          attributeFilter: ['class', 'style', 'hidden', 'src', 'href'],
          childList: true, characterData: true, characterDataOldValue: true, subtree: true,
        });
      });
    });
  });

  window.__dumpReconTrace = function () { return 'see console log with prefix [RECON-TRACE]'; };
})();
