/**
 * Robayer WealthLab: Meta Pixel bootstrap + extensible conversion-event
 * layer — Version 5.0 (Customer Acquisition Phase 1).
 *
 * Loaded once, dynamically, by js/main.js's loadMetaPixel() — the one
 * genuine "every real customer-facing page" injection point this
 * codebase has (see that function's own header comment). Never
 * included as a static <script> tag on any individual page, so there
 * is exactly one load path to reason about, matching this file's own
 * "install once, never duplicate" requirement by construction rather
 * than by a runtime guard.
 *
 * Two responsibilities, deliberately kept in one file since they're
 * genuinely coupled (the second cannot exist without the first):
 *
 * 1. The real Meta base pixel snippet (fbq stub + fbevents.js loader),
 *    initialized with the real Pixel ID passed via this script's own
 *    [data-pixel-id] attribute (set by js/main.js from
 *    assets/config/site.json — never hardcoded here), firing the
 *    automatic PageView every page needs (Phase 1/2).
 *
 * 2. `window.RobayerTracking.track(eventName, params)` — the
 *    extensible event layer (Phase 6). A small STANDARD_EVENTS
 *    allowlist decides whether a call becomes `fbq('track', ...)`
 *    (Meta's own standard vocabulary: ViewContent, InitiateCheckout,
 *    Purchase, Lead) or `fbq('trackCustom', ...)` (this project's own
 *    named events: AskAI, CouponApplied, Download, and — the whole
 *    point of this being data-driven, not a hardcoded switch — any
 *    future event a later feature (BookPreview, SearchKnowledgeBase, a
 *    future book/course) calls with a name that isn't in the allowlist
 *    yet. Adding a new custom event anywhere else on the site is
 *    exactly one `RobayerTracking.track('EventName', {...})` call at
 *    that feature's own success point — nothing here ever needs to
 *    change for it.
 *
 * Every call is wrapped so a missing/blocked `fbq` (ad-blocker, or the
 * base snippet failing to load) can never throw into the caller — the
 * exact same "never block the real action" discipline
 * js/components/analytics.js's own send() already applies to the
 * first-party beacon.
 */

(function () {
  var scriptEl = document.currentScript;
  var pixelId = scriptEl && scriptEl.getAttribute('data-pixel-id');
  if (!pixelId) return;

  // Meta's own documented base code (https://www.facebook.com/business/help/952192354843755),
  // reproduced verbatim in structure — defines the `fbq` stub that
  // queues calls until fbevents.js itself finishes loading.
  /* eslint-disable */
  (function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = true;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq('init', pixelId);
  window.fbq('track', 'PageView');

  var STANDARD_EVENTS = new Set(['PageView', 'ViewContent', 'InitiateCheckout', 'Purchase', 'Lead']);

  /**
   * The one entry point every other component file calls into. Never
   * throws: a params value Meta doesn't recognize, or fbq itself being
   * unavailable, degrades to a silent no-op — conversion tracking must
   * never be able to break the real feature (checkout, a form submit,
   * an AI answer) that triggered it, the same standard
   * conversionDispatchService.ts holds server-side.
   */
  function track(eventName, params, options) {
    try {
      if (typeof window.fbq !== 'function') return;
      var fbqOptions = options && options.eventId ? { eventID: options.eventId } : undefined;
      if (STANDARD_EVENTS.has(eventName)) {
        window.fbq('track', eventName, params || {}, fbqOptions);
      } else {
        window.fbq('trackCustom', eventName, params || {}, fbqOptions);
      }
    } catch (err) {
      // Deliberately swallowed — see this file's own header comment.
    }
  }

  window.RobayerTracking = { track: track, standardEvents: STANDARD_EVENTS };

  // Phase 2 — ViewContent on any page that declares what content it
  // is, via a <meta name="robayer-page-content"> tag (set by the
  // product/blog/investment-centre/resources/Customer AI page itself —
  // see backend/routes/books.ts, backend/routes/blog.ts, and the
  // equivalent static pages). Deliberately a <meta> tag, not an inline
  // <script>: this site's own Content-Security-Policy (script-src
  // 'self', no 'unsafe-inline' — see backend/middleware/securityHeaders.ts)
  // blocks inline scripts by design, and a <meta> tag isn't subject to
  // that directive at all. Never guessed from the URL, so a page that
  // doesn't genuinely represent one product/article never fires a
  // misleading ViewContent.
  var pageContentTag = document.querySelector('meta[name="robayer-page-content"]');
  var pageContent = null;
  if (pageContentTag) {
    try {
      pageContent = JSON.parse(pageContentTag.getAttribute('content'));
    } catch (err) {
      pageContent = null;
    }
  }
  if (pageContent && pageContent.contentType) {
    track('ViewContent', {
      content_type: pageContent.contentType,
      content_ids: pageContent.contentId ? [pageContent.contentId] : undefined,
      content_name: pageContent.contentName,
      value: pageContent.value,
      currency: pageContent.value ? 'GHS' : undefined,
    });
  }
})();
