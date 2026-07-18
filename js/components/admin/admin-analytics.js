/**
 * Robayer WealthLab — Analytics admin page (Version 2.0 Phase 3 Stage 4,
 * Operational Visibility)
 *
 * Drives admin/analytics/index.html: a date-range picker, six real KPI
 * cards with period-over-period comparison, two inline SVG time-series
 * charts (window.AdminCharts, see timeseries-chart.js), and a real Top
 * Products table. Visitors/Sessions/Traffic Sources are never faked —
 * see the card at the bottom of the page linking out to the real
 * Cloudflare Web Analytics dashboard (docs/v2-analytics-spec.md's
 * explicit data-source boundary).
 */

const ANALYTICS_API_BASE = '/api/admin/analytics';

function initAdminAnalytics() {
  const root = document.querySelector('[data-analytics-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    from: '',
    to: '',
  };

  const els = {
    loadError: root.querySelector('[data-analytics-load-error]'),
    presetChips: Array.from(root.querySelectorAll('[data-analytics-preset]')),
    dateFrom: root.querySelector('[data-analytics-date-from]'),
    dateTo: root.querySelector('[data-analytics-date-to]'),
    chartOrders: root.querySelector('[data-chart-orders]'),
    chartSubscribers: root.querySelector('[data-chart-subscribers]'),
    topProductsEmpty: root.querySelector('[data-top-products-empty]'),
    topProductsTableWrap: root.querySelector('[data-top-products-table-wrap]'),
    topProductsBody: root.querySelector('[data-top-products-body]'),
  };

  applyPreset(30, { skipRefresh: true });
  bindToolbar();
  refresh();

  function bindToolbar() {
    els.presetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        applyPreset(Number(chip.getAttribute('data-analytics-preset')));
      });
    });

    els.dateFrom.addEventListener('change', () => {
      state.from = els.dateFrom.value;
      syncChips(null);
      refresh();
    });
    els.dateTo.addEventListener('change', () => {
      state.to = els.dateTo.value;
      syncChips(null);
      refresh();
    });
  }

  function applyPreset(days, options) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    state.to = formatDateInput(to);
    state.from = formatDateInput(from);
    els.dateFrom.value = state.from;
    els.dateTo.value = state.to;
    syncChips(days);
    if (!options || !options.skipRefresh) refresh();
  }

  function syncChips(activeDays) {
    els.presetChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(Number(chip.getAttribute('data-analytics-preset')) === activeDays));
    });
  }

  async function refresh() {
    els.loadError.hidden = true;
    const params = new URLSearchParams({ from: state.from, to: state.to });

    try {
      const [summary, timeseries, topProducts] = await Promise.all([
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/summary?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/timeseries?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/top-products?${params.toString()}`),
      ]);
      renderSummary(summary);
      renderCharts(timeseries);
      renderTopProducts(topProducts.items);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load analytics.';
      els.loadError.hidden = false;
    }
  }

  function renderSummary(summary) {
    renderKpi('revenue', summary.revenuePesewas, (v) => formatCurrency(v / 100), 'vs previous period');
    renderKpi('orders', summary.orders, (v) => String(v), 'vs previous period');
    renderKpi('subscribers', summary.newSubscribers, (v) => String(v), 'vs previous period');
    renderKpi('downloads', summary.downloadsServed, (v) => String(v), 'vs previous period');
    renderKpi('consultations', summary.consultations, (v) => String(v), 'vs previous period');
    renderKpi('contacts', summary.contacts, (v) => String(v), 'vs previous period');
  }

  function renderKpi(key, metric, formatValue, comparisonLabel) {
    const valueEl = root.querySelector(`[data-kpi-${key}-value]`);
    const metaEl = root.querySelector(`[data-kpi-${key}-meta]`);
    valueEl.textContent = formatValue(metric.current);

    metaEl.innerHTML = '';
    const badge = document.createElement('span');
    if (metric.deltaPercent === null) {
      badge.className = 'badge badge--info';
      badge.textContent = 'New';
    } else if (metric.deltaPercent > 0) {
      badge.className = 'badge badge--success';
      badge.textContent = `+${metric.deltaPercent}%`;
    } else if (metric.deltaPercent < 0) {
      badge.className = 'badge badge--error';
      badge.textContent = `${metric.deltaPercent}%`;
    } else {
      badge.className = 'badge badge--info';
      badge.textContent = '0%';
    }
    const label = document.createElement('span');
    label.className = 'text-secondary text-small';
    label.style.marginLeft = 'var(--space-2)';
    label.textContent = comparisonLabel;
    metaEl.append(badge, label);
  }

  function renderCharts(timeseries) {
    window.AdminCharts.renderTimeseries(els.chartOrders, timeseries.ordersPerDay, { color: 'var(--color-accent)' });
    window.AdminCharts.renderTimeseries(els.chartSubscribers, timeseries.subscribersPerDay, { color: 'var(--color-sika-gold)' });
  }

  function renderTopProducts(items) {
    const hasItems = items && items.length > 0;
    els.topProductsEmpty.hidden = hasItems;
    els.topProductsTableWrap.hidden = !hasItems;
    if (!hasItems) return;

    els.topProductsBody.innerHTML = '';
    items.forEach((item) => {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      titleCell.textContent = item.title;
      const ordersCell = document.createElement('td');
      ordersCell.textContent = String(item.orderCount);
      const revenueCell = document.createElement('td');
      revenueCell.textContent = formatCurrency(item.revenuePesewas / 100);
      row.append(titleCell, ordersCell, revenueCell);
      els.topProductsBody.appendChild(row);
    });
  }
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

/** Same GH₵ formatting convention as admin-dashboard.js's own formatCurrency() — a small local copy per independent page family, not a shared utility. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

document.addEventListener('partials:loaded', initAdminAnalytics);
