/**
 * TEMPORARY — Version 4.2.5 root-cause trace. Diagnostic only: patches
 * property setters to record who writes what, when, from where. No
 * behavior change. Remove this file and its <script> tag once the
 * exact cause is confirmed.
 */
(function () {
  var log = [];
  function record(kind, extra) {
    var entry = Object.assign({ kind: kind, t: performance.now() }, extra);
    log.push(entry);
    console.log('[TRACE] ' + entry.t.toFixed(2) + 'ms  ' + kind + '  ' + JSON.stringify(extra));
  }
  window.__heroTrace = log;

  record('script-start', { readyState: document.readyState });

  // --- Patch HTMLImageElement.prototype.src to catch every write, with caller stack ---
  var nativeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: function () {
      return nativeSrcDescriptor.get.call(this);
    },
    set: function (value) {
      var isTarget = this.matches && (this.matches('[data-feature-cover-img]') || this.classList.contains('book-card__cover-image'));
      if (isTarget) {
        record('img.src SET', {
          className: this.className,
          oldValue: nativeSrcDescriptor.get.call(this),
          newValue: value,
          stack: new Error().stack,
        });
      }
      return nativeSrcDescriptor.set.call(this, value);
    },
  });

  // --- Patch the `hidden` property on Element.prototype (affects all elements, filter to targets) ---
  var nativeHiddenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
  Object.defineProperty(HTMLElement.prototype, 'hidden', {
    configurable: true,
    get: function () {
      return nativeHiddenDescriptor.get.call(this);
    },
    set: function (value) {
      var isTarget = this.matches && (
        this.matches('[data-feature-cover-img]') ||
        this.matches('[data-feature-placeholder]') ||
        this.classList.contains('book-card__cover-image') ||
        this.classList.contains('book-card__cover-placeholder-text')
      );
      if (isTarget) {
        record('.hidden SET', {
          className: this.className,
          oldValue: nativeHiddenDescriptor.get.call(this),
          newValue: value,
          stack: new Error().stack,
        });
      }
      return nativeHiddenDescriptor.set.call(this, value);
    },
  });

  // --- Patch setAttribute for src/hidden too, in case anything uses that path instead ---
  var nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if ((name === 'src' || name === 'hidden') && this.matches && (
      this.matches('[data-feature-cover-img]') ||
      this.matches('[data-feature-placeholder]') ||
      this.classList.contains('book-card__cover-image') ||
      this.classList.contains('book-card__cover-placeholder-text')
    )) {
      record('setAttribute(' + name + ')', { className: this.className, value: value, stack: new Error().stack });
    }
    return nativeSetAttribute.call(this, name, value);
  };

  // --- Lifecycle ---
  document.addEventListener('readystatechange', function () { record('readystatechange:' + document.readyState); });
  document.addEventListener('DOMContentLoaded', function () { record('DOMContentLoaded'); });
  window.addEventListener('load', function () { record('window.load'); });

  // --- Paint / LCP ---
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) { record('paint:' + e.name, { startTime: e.startTime }); });
    }).observe({ type: 'paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        record('LCP-candidate', { startTime: e.startTime, url: e.url || null, elementClass: e.element ? e.element.className : null });
      });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}

  // --- Resource timing for products API and media files ---
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        if (e.name.indexOf('/api/products') !== -1 || e.name.indexOf('/api/media/file') !== -1) {
          record('resource:' + e.name.split('/').pop(), {
            startTime: e.startTime, responseStart: e.responseStart, responseEnd: e.responseEnd,
            transferSize: e.transferSize, encodedBodySize: e.encodedBodySize,
          });
        }
      });
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}

  // --- Duplicate-element census ---
  document.addEventListener('DOMContentLoaded', function () {
    record('census', {
      totalImgTags: document.querySelectorAll('img').length,
      featureBannerCount: document.querySelectorAll('[data-feature-banner]').length,
      featureCoverImgCount: document.querySelectorAll('[data-feature-cover-img]').length,
      featurePlaceholderCount: document.querySelectorAll('[data-feature-placeholder]').length,
      duplicateIds: (function () {
        var ids = {};
        document.querySelectorAll('[id]').forEach(function (el) { ids[el.id] = (ids[el.id] || 0) + 1; });
        return Object.entries(ids).filter(function (pair) { return pair[1] > 1; });
      })(),
    });
  });

  // Expose a way to dump the full log as JSON on demand
  window.__dumpHeroTrace = function () { return JSON.stringify(log); };
})();
