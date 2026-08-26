/**
 * Robayer WealthLab — Sales Funnel (Admin Analytics Dashboard v2,
 * 2026-08-27). Drives the Sales Funnel section on
 * admin/analytics/index.html via GET /api/admin/analytics/funnel —
 * see services/admin/analyticsService.ts's getSalesFunnel() for the
 * exact query and why `bookViews` (product_view) is now the
 * authoritative book-page-visit signal, not a fallback.
 *
 * Renders the core, strictly-decreasing chain — Visitors → Book Views
 * → Checkout Starts → Purchases — matching the four real, unambiguous
 * gates a visitor passes through. Coupon Applications is shown
 * alongside as a related stat, not forced into the strict chain: not
 * everyone who buys uses a coupon, so treating it as a required
 * funnel stage would misrepresent it as a gate rather than an
 * optional path. Every percentage is computed from the two real
 * numbers on either side of it; a zero denominator renders "—", never
 * a fabricated 0% or NaN.
 */

const SALES_FUNNEL_API = '/api/admin/analytics/funnel';

const STAGES = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'bookViews', label: 'Book Views' },
  { key: 'checkoutStarts', label: 'Checkout Starts' },
  { key: 'purchases', label: 'Purchases' },
];

function initAdminSalesFunnel() {
  const root = document.querySelector('[data-sales-funnel-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const dateFrom = document.querySelector('[data-analytics-date-from]');
  const dateTo = document.querySelector('[data-analytics-date-to]');
  const presetChips = Array.from(document.querySelectorAll('[data-analytics-preset], [data-analytics-preset-named]'));

  const els = {
    loadError: root.querySelector('[data-sales-funnel-load-error]'),
    chain: root.querySelector('[data-sales-funnel-chain]'),
    overallRate: root.querySelector('[data-sales-funnel-overall-rate]'),
    couponNote: root.querySelector('[data-sales-funnel-coupon-note]'),
    trackingNote: root.querySelector('[data-sales-funnel-tracking-note]'),
  };

  refresh();
  presetChips.forEach((chip) => chip.addEventListener('click', () => refresh()));
  if (dateFrom) dateFrom.addEventListener('change', refresh);
  if (dateTo) dateTo.addEventListener('change', refresh);
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  /** Mirrors admin-analytics.js's own buildParams(). */
  function buildParams() {
    const allTimeChip = document.querySelector('[data-analytics-preset-named="all_time"]');
    if (allTimeChip && allTimeChip.getAttribute('aria-pressed') === 'true') {
      return new URLSearchParams({ allTime: 'true' });
    }
    const params = new URLSearchParams();
    if (dateFrom && dateFrom.value) params.set('from', dateFrom.value);
    if (dateTo && dateTo.value) params.set('to', dateTo.value);
    return params;
  }

  async function refresh() {
    if (els.loadError) els.loadError.hidden = true;
    const params = buildParams();
    try {
      const funnel = await window.AdminAuth.adminFetch(`${SALES_FUNNEL_API}?${params.toString()}`);
      render(funnel);
    } catch (error) {
      if (els.loadError) {
        els.loadError.textContent = error.message || 'Could not load the sales funnel.';
        els.loadError.hidden = false;
      }
    }
  }

  function rate(numerator, denominator) {
    return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  }

  function render(funnel) {
    if (els.trackingNote) {
      els.trackingNote.hidden = !funnel.visitorsClamped;
    }

    if (els.chain) {
      els.chain.innerHTML = '';
      const values = STAGES.map((s) => funnel[s.key]);
      const maxValue = Math.max(1, ...values);

      STAGES.forEach((stage, index) => {
        const value = funnel[stage.key];
        const widthPercent = Math.max(8, Math.round((value / maxValue) * 100));

        if (index > 0) {
          const stepRate = rate(value, values[index - 1]);
          const connector = document.createElement('div');
          connector.className = 'funnel-connector';
          connector.innerHTML = `<span class="funnel-connector__arrow" aria-hidden="true">&darr;</span><span class="funnel-connector__rate">${stepRate === null ? '—' : stepRate + '%'}</span>`;
          els.chain.appendChild(connector);
        }

        const stageEl = document.createElement('div');
        stageEl.className = 'funnel-stage';
        const bar = document.createElement('div');
        bar.className = 'funnel-stage__bar';
        bar.style.width = widthPercent + '%';
        bar.innerHTML = `<span class="funnel-stage__value">${value.toLocaleString()}</span><span class="funnel-stage__label">${stage.label}</span>`;
        stageEl.appendChild(bar);
        els.chain.appendChild(stageEl);
      });
    }

    const overall = rate(funnel.purchases, funnel.visitors);
    if (els.overallRate) {
      els.overallRate.textContent = overall === null
        ? 'Overall visitor-to-purchase rate: —'
        : `Overall visitor-to-purchase rate: ${overall}%`;
    }

    if (els.couponNote) {
      const couponRate = rate(funnel.couponApplications, funnel.checkoutStarts);
      els.couponNote.textContent = couponRate === null
        ? `${funnel.couponApplications} coupon application${funnel.couponApplications === 1 ? '' : 's'} in this range.`
        : `${funnel.couponApplications} coupon application${funnel.couponApplications === 1 ? '' : 's'} — ${couponRate}% of checkout starts used a coupon.`;
    }
  }
}

document.addEventListener('partials:loaded', initAdminSalesFunnel);
