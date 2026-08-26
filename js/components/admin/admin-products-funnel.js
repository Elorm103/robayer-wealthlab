/**
 * Robayer WealthLab — Per-book funnel table (Analytics & User-Activity
 * Baseline). Drives the [data-products-funnel-wrap] table in
 * admin/analytics/index.html's Products section: one row per real
 * `products` row (views/checkout starts/purchases/revenue/downloads/
 * conversion), generalizing automatically to future books — see
 * services/admin/analyticsService.ts's getPerBookFunnel().
 *
 * Reuses the page's existing date-range toolbar instead of adding a
 * second one — a second, independent script listening to the same
 * controls, matching admin-traffic.js's own convention.
 */

const FUNNEL_API = '/api/admin/analytics/products/funnel';
/** Matches utils/analyticsConfig.ts's ANALYTICS_TRACKING_START_DATE. */
const TRACKING_START_DATE = '2026-08-25';

function initAdminProductsFunnel() {
  const wrap = document.querySelector('[data-products-funnel-wrap]');
  if (!wrap || wrap.hasAttribute('data-bound')) return;
  wrap.setAttribute('data-bound', 'true');

  const body = wrap.querySelector('[data-products-funnel-body]');
  const trackingNote = document.querySelector('[data-products-funnel-tracking-note]');
  const dateFrom = document.querySelector('[data-analytics-date-from]');
  const dateTo = document.querySelector('[data-analytics-date-to]');
  const presetChips = Array.from(document.querySelectorAll('[data-analytics-preset], [data-analytics-preset-named]'));

  refresh();
  presetChips.forEach((chip) => chip.addEventListener('click', () => refresh()));
  if (dateFrom) dateFrom.addEventListener('change', refresh);
  if (dateTo) dateTo.addEventListener('change', refresh);
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  /** Mirrors admin-analytics.js's own buildParams() — "All time" clears the date inputs and sets a flag the backend recognizes rather than a huge literal date range. */
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
    const params = buildParams();

    try {
      const data = await window.AdminAuth.adminFetch(`${FUNNEL_API}?${params.toString()}`);
      trackingNote.hidden = !(dateFrom && dateFrom.value && dateFrom.value < TRACKING_START_DATE);
      render(data.items || []);
    } catch (error) {
      body.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-secondary text-small';
      td.textContent = error.message || 'Could not load the per-book funnel.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  function render(items) {
    body.innerHTML = '';
    if (items.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-secondary text-small';
      td.textContent = 'No products found.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    items.forEach((item) => {
      const tr = document.createElement('tr');
      const cells = [
        item.title,
        String(item.views),
        String(item.checkoutStarts),
        String(item.purchases),
        formatCurrency(item.revenuePesewas / 100),
        String(item.downloads),
        item.conversionRate === null ? '—' : `${item.conversionRate}%`,
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
}

/** Same GH₵ formatting convention as admin-analytics.js's own formatCurrency() — a small local copy per independent script, not a shared utility. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

document.addEventListener('partials:loaded', initAdminProductsFunnel);
