/**
 * Robayer WealthLab: first-party measurement beacon (Version 4.0
 * Milestone A: Measurement Foundation).
 *
 * Fires exactly two kinds of event, both answering a named business
 * question from the milestone brief, neither anything more:
 *   - page_view: "where are visitors dropping off," "which pages
 *     convert," "which products attract attention," "which traffic
 *     sources convert" (via referrer/utm_*).
 *   - cta_click: "which buttons are clicked," "which lead magnets
 *     perform best." Deliberately keyed off attributes/classes these
 *     pages already carry for other reasons ([data-buy-button],
 *     [data-feature-cta], etc.) rather than requiring a new
 *     data-analytics-* attribute added to every button on the site -
 *     reusing existing markup instead of touching it.
 *
 * Privacy: session_id is a random UUID stored in sessionStorage only
 * (never a cookie, discarded when the tab closes, never linked to a
 * customer identity). No IP, user agent, or fingerprinting data is
 * ever sent. utm_source/medium/campaign are read from the URL once,
 * on the page that actually carries them, then carried forward in
 * sessionStorage so a later page view in the same session still
 * attributes correctly.
 *
 * Never blocks or delays the page: uses navigator.sendBeacon() where
 * available (fire-and-forget, survives page unload), falling back to
 * a keepalive fetch with no awaited response.
 */

(function () {
  const SESSION_KEY = 'robayer_analytics_session';
  const UTM_KEY = 'robayer_analytics_utm';

  function getSessionId() {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function getUtm() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = {
      utmSource: params.get('utm_source'),
      utmMedium: params.get('utm_medium'),
      utmCampaign: params.get('utm_campaign'),
    };
    if (fromUrl.utmSource || fromUrl.utmMedium || fromUrl.utmCampaign) {
      sessionStorage.setItem(UTM_KEY, JSON.stringify(fromUrl));
      return fromUrl;
    }
    try {
      const stored = sessionStorage.getItem(UTM_KEY);
      if (stored) return JSON.parse(stored);
    } catch {
      // Malformed stored value - fall through to "no UTM data" rather than throw.
    }
    return { utmSource: null, utmMedium: null, utmCampaign: null };
  }

  function send(payload) {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon('/api/analytics/event', blob);
    } else {
      fetch('/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  }

  function trackPageView() {
    const utm = getUtm();
    send({
      eventType: 'page_view',
      pagePath: window.location.pathname,
      referrer: document.referrer || null,
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      sessionId: getSessionId(),
    });
  }

  // Selector -> stable cta_id. Deliberately reuses attributes/classes
  // these elements already carry for their own real purpose (buying,
  // featuring a product, submitting a newsletter form) rather than
  // adding a new data-analytics-* attribute to every button on the
  // site - see this file's own header comment.
  const CTA_SELECTORS = [
    { selector: '[data-buy-button]', id: 'buy-now' },
    { selector: '[data-feature-cta]', id: 'featured-product-cta' },
    { selector: '[data-featured-resource-cta]', id: 'featured-resource-cta' },
    { selector: '[data-newsletter-form] button[type="submit"]', id: 'newsletter-subscribe' },
    { selector: '[data-placeholder-action]', id: 'resource-download-placeholder' },
    { selector: '.hero__actions a.btn--primary', id: 'hero-primary-cta' },
    { selector: '.hero__actions a.btn--secondary', id: 'hero-secondary-cta' },
    // Revenue Engine Phase 5 (Financial Literacy Bundle) — the
    // individual-book-page cross-sell and post-purchase-confirmation
    // upsell CTAs, both plain links to the bundle's own product page
    // (not a checkout call themselves), see routes/books.ts and
    // js/components/fulfilment-status.js.
    { selector: '[data-bundle-cross-sell-cta]', id: 'bundle-cross-sell-cta' },
    { selector: '[data-bundle-upsell-cta]', id: 'bundle-post-purchase-cta' },
  ];

  function trackCtaClicks() {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        for (const { selector, id } of CTA_SELECTORS) {
          if (target.closest(selector)) {
            send({ eventType: 'cta_click', pagePath: window.location.pathname, ctaId: id, sessionId: getSessionId() });
            return; // First matching selector wins - avoids double-counting a button matched by more than one rule.
          }
        }
      },
      { capture: true }
    );
  }

  function init() {
    trackPageView();
    trackCtaClicks();
  }

  // Fires once per real page load, deliberately not re-bound on
  // partials:loaded (page views should count navigations, not partial
  // includes finishing) - the click tracker's own delegated listener
  // is safe to attach once at DOMContentLoaded regardless of when
  // partials finish loading, since it matches against whatever is in
  // the DOM at click time, not at bind time.
  document.addEventListener('DOMContentLoaded', init);
})();
