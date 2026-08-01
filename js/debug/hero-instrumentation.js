/**
 * TEMPORARY — Version 4.2.1 Hero Cover Flicker Instrumentation.
 * Diagnostic only: adds console logging and observers, changes no
 * existing behavior, reveals nothing, hides nothing, delays nothing.
 * Remove this file and its <script> tag once the flicker's exact
 * cause has been identified and fixed.
 */
(function () {
  var t0 = performance.timeOrigin;
  function log(label, extra) {
    var line = '[HERO-DEBUG] ' + performance.now().toFixed(2) + 'ms  ' + label;
    if (extra !== undefined) {
      try { line += '  ' + JSON.stringify(extra); } catch (e) { line += '  ' + String(extra); }
    }
    console.log(line);
  }
  window.__heroDebugLog = log;

  log('instrumentation script executing', { readyState: document.readyState });

  document.addEventListener('readystatechange', function () {
    log('readystatechange: ' + document.readyState);
  });
  document.addEventListener('DOMContentLoaded', function () {
    log('DOMContentLoaded');
  });
  window.addEventListener('load', function () {
    log('window.load');
  });

  // --- Paint / LCP timing ---
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        log('paint: ' + entry.name, { startTime: entry.startTime.toFixed(2) });
      });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) { log('paint PerformanceObserver unavailable', String(e)); }

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        log('largest-contentful-paint candidate', {
          startTime: entry.startTime.toFixed(2),
          size: entry.size,
          url: entry.url || null,
          elementClass: entry.element ? entry.element.className : null,
        });
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { log('LCP PerformanceObserver unavailable', String(e)); }

  // --- Network timing for /api/products and the cover image ---
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.name.indexOf('/api/products') !== -1 || entry.name.indexOf('/api/media/file') !== -1) {
          log('resource timing: ' + entry.name, {
            startTime: entry.startTime.toFixed(2),
            responseStart: entry.responseStart.toFixed(2),
            responseEnd: entry.responseEnd.toFixed(2),
            duration: entry.duration.toFixed(2),
          });
        }
      });
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { log('resource PerformanceObserver unavailable', String(e)); }

  // --- rAF marker ---
  requestAnimationFrame(function raf(ts) {
    log('requestAnimationFrame', { ts: ts.toFixed(2) });
  });

  function snapshot(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      className: el.className,
      hidden: el.hidden,
      src: el.getAttribute ? el.getAttribute('src') : undefined,
      opacity: cs.opacity,
      transform: cs.transform,
      display: cs.display,
      visibility: cs.visibility,
    };
  }

  function watch(selector) {
    document.querySelectorAll(selector).forEach(function (el, i) {
      log('MutationObserver attached: ' + selector + '[' + i + ']', snapshot(el));
      var mo = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          log('MUTATION ' + selector + '[' + i + '] ' + m.type + (m.attributeName ? (':' + m.attributeName) : ''), {
            oldValue: m.oldValue,
            now: snapshot(el),
          });
        });
      });
      mo.observe(el, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class', 'style', 'hidden', 'src'],
        childList: true,
        subtree: false,
      });

      // Debug-only IntersectionObserver, separate instance from the real
      // scroll-reveal.js one — purely observational, never mutates anything.
      try {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            log('IntersectionObserver (debug) fired: ' + selector + '[' + i + ']', {
              isIntersecting: entry.isIntersecting,
              intersectionRatio: entry.intersectionRatio.toFixed(3),
            });
          });
        }, { threshold: 0.15 }).observe(el);
      } catch (e) {}
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    log('--- attaching MutationObservers ---');
    [
      '.hero__visual',
      '.hero__visual-link',
      '.book-card__cover-image',
      '.book-card__cover-placeholder',
      '.book-card__cover-placeholder-text',
      '.hero__content',
      '.hero__text',
    ].forEach(watch);

    // --- Phase 4: duplicate element check ---
    var allImgs = document.querySelectorAll('img');
    log('document.querySelectorAll("img") total count', { count: allImgs.length });
    var heroImgs = Array.prototype.filter.call(allImgs, function (img) {
      return img.closest('.hero') || img.closest('[data-feature-banner]');
    });
    log('images inside .hero or [data-feature-banner]', {
      count: heroImgs.length,
      details: heroImgs.map(function (img) {
        return { className: img.className, src: img.src, hidden: img.hidden };
      }),
    });
    log('duplicate check: [data-feature-banner] count', { count: document.querySelectorAll('[data-feature-banner]').length });
    log('duplicate check: [data-feature-placeholder] count', { count: document.querySelectorAll('[data-feature-placeholder]').length });
    log('duplicate check: [data-feature-cover-img] count', { count: document.querySelectorAll('[data-feature-cover-img]').length });
  });
})();
