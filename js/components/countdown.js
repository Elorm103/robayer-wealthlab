/**
 * Robayer WealthLab: Sale Countdown
 *
 * Version 3.4.2 Milestone M6.2 (Dynamic Pricing Enhancement).
 *
 * Generic, product-agnostic: finds every `[data-sale-ends-at]` element
 * on the page (its value is an absolute ISO 8601 UTC timestamp, e.g.
 * "2026-08-05T00:00:00.000Z", exactly what GET /api/products and the
 * server-rendered book detail page both already emit) and keeps its
 * `[data-countdown-days]`/`-hours`/`-minutes`/`-seconds` children
 * updated once a second.
 *
 * Respects the visitor's own timezone with no special handling needed:
 * `new Date(isoString)` parses the UTC instant correctly regardless of
 * where the browser is, and subtracting from `new Date()` (the
 * visitor's own current instant) always yields the same real remaining
 * duration, since both sides of the subtraction are absolute instants,
 * never wall-clock strings.
 *
 * When a countdown reaches zero it does not need to ask the server
 * whether the sale is "really" over: reaching the exact instant in
 * `data-sale-ends-at` is definitionally the same computation
 * services/productService.ts's computeSaleState() already performs
 * server-side, so this hides the same elements that server-side
 * decision would already be hiding on the visitor's next real page
 * load, just without waiting for one. `[data-sale-only]` elements
 * (the badge, the strikethrough regular price, the countdown itself)
 * are hidden; `[data-regular-price-only]` elements (a plain, no-sale
 * price display normally kept hidden while a sale is active) are
 * revealed, restoring the regular-price-only view described in the
 * milestone brief's Phase 5 exactly.
 */

(function () {
  function pad(n) {
    return String(Math.max(0, n)).padStart(2, '0');
  }

  function renderRemaining(container, remainingMs) {
    const totalSeconds = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const daysEl = container.querySelector('[data-countdown-days]');
    const hoursEl = container.querySelector('[data-countdown-hours]');
    const minutesEl = container.querySelector('[data-countdown-minutes]');
    const secondsEl = container.querySelector('[data-countdown-seconds]');
    if (daysEl) daysEl.textContent = pad(days);
    if (hoursEl) hoursEl.textContent = pad(hours);
    if (minutesEl) minutesEl.textContent = pad(minutes);
    if (secondsEl) secondsEl.textContent = pad(seconds);
  }

  /** Hides every [data-sale-only] element sharing this countdown's own [data-sale-scope] card/section, and reveals [data-regular-price-only] in the same scope - the exact "remove discount, countdown, badge, strikethrough; restore regular price" swap the brief calls for. */
  function expireSaleUi(container) {
    const scope = container.closest('[data-sale-scope]') || container.parentElement;
    if (!scope) return;
    scope.querySelectorAll('[data-sale-only]').forEach((el) => { el.hidden = true; });
    scope.querySelectorAll('[data-regular-price-only]').forEach((el) => { el.hidden = false; });
  }

  function initCountdown(container) {
    const endsAt = container.getAttribute('data-sale-ends-at');
    if (!endsAt) return;
    const endTime = new Date(endsAt).getTime();
    if (Number.isNaN(endTime)) return;

    function tick() {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        expireSaleUi(container);
        clearInterval(intervalId);
        return;
      }
      renderRemaining(container, remaining);
    }

    tick();
    const intervalId = setInterval(tick, 1000);
  }

  function initAllCountdowns() {
    document.querySelectorAll('[data-sale-ends-at]:not([data-countdown-bound])').forEach((container) => {
      container.setAttribute('data-countdown-bound', 'true');
      initCountdown(container);
    });
  }

  // Runs on both events for the same reason every other per-page
  // component in this codebase does (see js/content-inject.js's header
  // comment): server-rendered pages (book detail) have their countdown
  // markup present at DOMContentLoaded, while client-rendered product
  // cards (product-loader.js) only exist once partials/product data has
  // finished loading, which can be after DOMContentLoaded fires. The
  // `:not([data-countdown-bound])` guard above makes re-running this
  // harmless either way.
  document.addEventListener('DOMContentLoaded', initAllCountdowns);
  document.addEventListener('partials:loaded', initAllCountdowns);
  document.addEventListener('products:rendered', initAllCountdowns);
})();
