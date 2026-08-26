/**
 * Robayer WealthLab: first-party measurement beacon (Version 4.0
 * Milestone A: Measurement Foundation; extended by the Analytics &
 * User-Activity Baseline for product_view and the Online Now
 * heartbeat).
 *
 * Fires three kinds of event, each answering a named business
 * question, neither anything more:
 *   - page_view: "where are visitors dropping off," "which pages
 *     convert," "which traffic sources convert" (via referrer/utm_*).
 *   - cta_click: "which buttons are clicked," "which lead magnets
 *     perform best." Deliberately keyed off attributes/classes these
 *     pages already carry for other reasons ([data-buy-button],
 *     [data-feature-cta], etc.) rather than requiring a new
 *     data-analytics-* attribute added to every button on the site -
 *     reusing existing markup instead of touching it.
 *   - product_view: "which products attract attention," per-book, not
 *     just per-page. Fires for any visit to a /books/{slug}/ URL,
 *     parsed directly from the page's own path — landing on the page
 *     IS the product view, independent of whether a Buy button (or
 *     any other DOM element) happens to be present. Reliable Sales
 *     Funnel Measurement pass: the earlier implementation read the
 *     Buy Now button's data-product-slug attribute instead, which
 *     confirmed real, false-negative gaps in production (visits that
 *     landed on the page and produced page_view but no product_view —
 *     traced to the button not always being the right signal, not to
 *     a single reproducible cause worth chasing further once a
 *     button-independent signal was available). See migration 0046's
 *     header comment for the matching utm_content column this also
 *     starts capturing.
 * Separately, a periodic heartbeat backs the admin dashboard's
 * "Online Now" count — a presence signal only, written to a
 * short-lived KV key server-side, never a database row (see
 * backend/routes/analytics.ts's handleAnalyticsHeartbeat()).
 *
 * Privacy: session_id is a random UUID stored in sessionStorage only
 * (never a cookie, discarded when the tab closes, never linked to a
 * customer identity unless the visitor is already logged in, in which
 * case the server resolves their existing customer id from their
 * existing session cookie — this script never sends one). No IP,
 * user agent, or fingerprinting data is ever sent from the client;
 * country/device-type are computed server-side from Cloudflare's edge
 * and the User-Agent header respectively, coarse-bucketed, never
 * stored raw. utm_source/medium/campaign are read from the URL once,
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
      utmContent: params.get('utm_content'),
    };
    if (fromUrl.utmSource || fromUrl.utmMedium || fromUrl.utmCampaign || fromUrl.utmContent) {
      sessionStorage.setItem(UTM_KEY, JSON.stringify(fromUrl));
      return fromUrl;
    }
    try {
      const stored = sessionStorage.getItem(UTM_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Sessions started before utm_content existed have a stored
        // value missing the key entirely — an explicit fallback here
        // (rather than `parsed.utmContent`, which is already
        // `undefined` and would serialize the same way) keeps the
        // returned shape identical regardless of when the session began.
        return { ...parsed, utmContent: parsed.utmContent || null };
      }
    } catch {
      // Malformed stored value - fall through to "no UTM data" rather than throw.
    }
    return { utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null };
  }

  function send(payload, endpoint) {
    const url = endpoint || '/api/analytics/event';
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
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
      utmContent: utm.utmContent,
      sessionId: getSessionId(),
    });
  }

  // Matches /books/{slug}/ (with or without a trailing slash) and
  // extracts the slug — the one part of the URL every book detail page
  // reliably carries, regardless of purchase state, DOM timing, or any
  // element's presence. Deliberately does NOT match /books/ itself
  // (the listing page, not a product) since the capture group requires
  // at least one character.
  const PRODUCT_PAGE_PATTERN = /^\/books\/([a-z0-9-]+)\/?$/;

  /** Fires once per real page load when the URL is a product detail page — works automatically for every current and future book, needs no per-product markup, and doesn't depend on any button or DOM state being present (see this file's own header comment for why this replaced the earlier Buy-button-based signal). */
  function trackProductView() {
    const match = window.location.pathname.match(PRODUCT_PAGE_PATTERN);
    if (!match) return;
    const utm = getUtm();
    send({
      eventType: 'product_view',
      pagePath: window.location.pathname,
      productSlug: match[1],
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      utmContent: utm.utmContent,
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
    // Analytics & User-Activity Baseline's site-wide announcement strip
    // (js/components/site-announcement.js) — a reusable, admin-editable
    // mechanism (not specific to any one campaign), so this cta_id
    // stays generic; which campaign drove the click is carried by the
    // announcement's own configured buttonUrl's utm_campaign, not a
    // new cta_id per campaign.
    { selector: '[data-announcement-button]', id: 'site-announcement-cta' },
    // CHECKED, NOT COPIED launch spotlight (index.html) — one static,
    // purpose-built homepage section for this release, same
    // per-feature cta_id convention as the bundle CTAs above.
    { selector: '[data-checked-not-copied-launch-cta]', id: 'checked-not-copied-launch-cta' },
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

  /** Online Now presence — refreshed every 60s, comfortably inside the server's 120s KV expiry so one missed beat (e.g. a briefly backgrounded tab) doesn't drop the visitor early. Widened from 45s (server TTL was 90s) to cut this feature's KV write volume by roughly a quarter after a 2026-08-26 KV-quota incident — see backend/routes/analytics.ts's ONLINE_NOW_TTL_SECONDS comment. Stops when the tab is hidden/closed rather than firing into the void — see visibilitychange handling in init(). */
  const HEARTBEAT_INTERVAL_MS = 60_000;
  let heartbeatTimer = null;

  function sendHeartbeat() {
    send({ sessionId: getSessionId() }, '/api/analytics/heartbeat');
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function init() {
    trackPageView();
    trackProductView();
    trackCtaClicks();
    startHeartbeat();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopHeartbeat();
      else startHeartbeat();
    });
  }

  // Fires once per real page load, deliberately not re-bound on
  // partials:loaded (page views should count navigations, not partial
  // includes finishing) - the click tracker's own delegated listener
  // is safe to attach once at DOMContentLoaded regardless of when
  // partials finish loading, since it matches against whatever is in
  // the DOM at click time, not at bind time.
  document.addEventListener('DOMContentLoaded', init);
})();
