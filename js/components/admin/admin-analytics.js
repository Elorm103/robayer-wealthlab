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
/** Admin Analytics Dashboard v2 — broadcast whenever the top-bar Refresh button is clicked, so every independent section script (admin-traffic.js, admin-products-funnel.js, etc.) can re-fetch without this file needing to know they exist. Each section adds one listener for this alongside its own toolbar listeners. */
const ANALYTICS_REFRESH_EVENT = 'admin-analytics:refresh-requested';

function initAdminAnalytics() {
  const root = document.querySelector('[data-analytics-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    from: '',
    to: '',
    allTime: false,
  };

  const els = {
    loadError: root.querySelector('[data-analytics-load-error]'),
    presetChips: Array.from(root.querySelectorAll('[data-analytics-preset]')),
    namedPresetChips: Array.from(root.querySelectorAll('[data-analytics-preset-named]')),
    dateFrom: root.querySelector('[data-analytics-date-from]'),
    dateTo: root.querySelector('[data-analytics-date-to]'),
    chartOrders: root.querySelector('[data-chart-orders]'),
    chartSubscribers: root.querySelector('[data-chart-subscribers]'),
    topProductsEmpty: root.querySelector('[data-top-products-empty]'),
    topProductsTableWrap: root.querySelector('[data-top-products-table-wrap]'),
    topProductsBody: root.querySelector('[data-top-products-body]'),
    growthTrackingNote: root.querySelector('[data-growth-tracking-note]'),
    todayRevenue: root.querySelector('[data-today-revenue-value]'),
    todayOrders: root.querySelector('[data-today-orders-value]'),
    refreshButton: document.querySelector('[data-analytics-refresh-button]'),
    lastUpdated: document.querySelector('[data-analytics-last-updated]'),
  };

  applyPreset(30, { skipRefresh: true });
  bindToolbar();
  refresh();
  refreshToday();

  if (els.refreshButton) {
    els.refreshButton.addEventListener('click', () => {
      document.dispatchEvent(new Event(ANALYTICS_REFRESH_EVENT));
      refresh();
      refreshToday();
    });
  }

  function bindToolbar() {
    els.presetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        applyPreset(Number(chip.getAttribute('data-analytics-preset')));
      });
    });

    els.namedPresetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        applyNamedPreset(chip.getAttribute('data-analytics-preset-named'));
      });
    });

    els.dateFrom.addEventListener('change', () => {
      state.from = els.dateFrom.value;
      syncChips(null, null);
      refresh();
    });
    els.dateTo.addEventListener('change', () => {
      state.to = els.dateTo.value;
      syncChips(null, null);
      refresh();
    });
  }

  function applyPreset(days, options) {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    state.to = formatDateInput(to);
    state.from = formatDateInput(from);
    state.allTime = false;
    els.dateFrom.value = state.from;
    els.dateTo.value = state.to;
    syncChips(days, null);
    if (!options || !options.skipRefresh) refresh();
  }

  /** Today/Yesterday/This month/Previous month/All time — each computes an explicit from/to (or, for "all_time", sets a flag the backend recognizes) rather than a day count, since these presets aren't fixed-length windows. */
  function applyNamedPreset(name) {
    const now = new Date();
    state.allTime = false;

    if (name === 'today') {
      state.from = state.to = formatDateInput(now);
    } else if (name === 'yesterday') {
      const y = new Date(now.getTime() - 86400000);
      state.from = state.to = formatDateInput(y);
    } else if (name === 'this_month') {
      state.from = formatDateInput(new Date(now.getFullYear(), now.getMonth(), 1));
      state.to = formatDateInput(now);
    } else if (name === 'previous_month') {
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      state.from = formatDateInput(new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1));
      state.to = formatDateInput(lastMonthEnd);
    } else if (name === 'all_time') {
      state.allTime = true;
      state.from = '';
      state.to = '';
    }

    els.dateFrom.value = state.from;
    els.dateTo.value = state.to;
    syncChips(null, name);
    refresh();
  }

  function syncChips(activeDays, activeNamed) {
    els.presetChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(Number(chip.getAttribute('data-analytics-preset')) === activeDays));
    });
    els.namedPresetChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-analytics-preset-named') === activeNamed));
    });
  }

  function buildParams() {
    return state.allTime ? new URLSearchParams({ allTime: 'true' }) : new URLSearchParams({ from: state.from, to: state.to });
  }

  async function refresh() {
    els.loadError.hidden = true;
    const params = buildParams();

    try {
      const [summary, timeseries, topProducts, activationSummary, growth] = await Promise.all([
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/summary?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/timeseries?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/top-products?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/activation-summary?${params.toString()}`),
        window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/growth?${params.toString()}`),
      ]);
      renderSummary(summary);
      renderCharts(timeseries);
      renderTopProducts(topProducts.items);
      renderActivationSummary(activationSummary);
      renderGrowth(growth);
      if (els.lastUpdated) els.lastUpdated.textContent = 'Last updated ' + new Date().toLocaleTimeString();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load analytics.';
      els.loadError.hidden = false;
    }
  }

  /** Always "today," independent of the toolbar's selected range — see this page's Today section. */
  async function refreshToday() {
    const todayStr = formatDateInput(new Date());
    const params = new URLSearchParams({ from: todayStr, to: todayStr });
    try {
      const summary = await window.AdminAuth.adminFetch(`${ANALYTICS_API_BASE}/summary?${params.toString()}`);
      els.todayRevenue.textContent = formatCurrency(summary.revenuePesewas.current / 100);
      els.todayOrders.textContent = String(summary.orders.current);
    } catch {
      // Non-critical, always-on snapshot — leave the skeleton in place rather than surfacing a page-wide error for it.
    }
  }

  function renderGrowth(growth) {
    renderKpi('registeredUsers', growth.registeredUsers, (v) => String(v), 'vs previous period');
    renderKpi('uniqueVisitors', growth.uniqueVisitors, (v) => String(v), 'vs previous period');
    els.growthTrackingNote.hidden = !growth.visitorsClamped;
  }

  function renderSummary(summary) {
    renderKpi('revenue', summary.revenuePesewas, (v) => formatCurrency(v / 100), 'vs previous period');
    renderKpi('orders', summary.orders, (v) => String(v), 'vs previous period');
    renderKpi('subscribers', summary.newSubscribers, (v) => String(v), 'vs previous period');
    renderKpi('downloads', summary.downloadsServed, (v) => String(v), 'vs previous period');
    renderKpi('consultations', summary.consultations, (v) => String(v), 'vs previous period');
    renderKpi('contacts', summary.contacts, (v) => String(v), 'vs previous period');
    renderAov(summary.revenuePesewas, summary.orders);
  }

  /**
   * Admin Analytics Dashboard v2 — Average Order Value, a derived
   * ratio of two real KpiMetric values already fetched above (never a
   * new backend query). "—" when there are zero orders, never a
   * divide-by-zero or a fabricated value. Built as a synthetic
   * KpiMetric object so it can reuse renderKpi()'s own comparison-
   * badge rendering unchanged.
   */
  function renderAov(revenue, orders) {
    const current = orders.current > 0 ? Math.round(revenue.current / orders.current) : null;
    const previous = orders.previous > 0 ? Math.round(revenue.previous / orders.previous) : null;
    const valueEl = root.querySelector('[data-kpi-aov-value]');
    const metaEl = root.querySelector('[data-kpi-aov-meta]');
    if (!valueEl || !metaEl) return;

    if (current === null) {
      valueEl.textContent = '—';
      metaEl.textContent = 'No orders in this range';
      return;
    }
    renderKpi('aov', { current, previous: previous ?? current, deltaPercent: previous === null ? null : deltaPercentOf(current, previous) }, (v) => formatCurrency(v / 100), 'vs previous period');
  }

  function deltaPercentOf(current, previous) {
    if (previous === 0) return current === 0 ? 0 : null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
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

  /** Version 3.3 Milestone M5C — reuses renderKpi() exactly like renderSummary() above; checkoutCompletionRate is the one plain (non-comparison) value here, since it's a ratio at a point in time, not a current-vs-previous count. */
  function renderActivationSummary(activationSummary) {
    renderKpi('checkoutStarts', activationSummary.checkoutStarts, (v) => String(v), 'vs previous period');
    renderKpi('checkoutCompletions', activationSummary.checkoutCompletions, (v) => String(v), 'vs previous period');
    renderKpi('couponRedemptions', activationSummary.couponRedemptions, (v) => String(v), 'vs previous period');
    renderKpi('reviewsSubmitted', activationSummary.reviewsSubmitted, (v) => String(v), 'vs previous period');
    renderKpi('dashboardActiveCustomers', activationSummary.dashboardActiveCustomers, (v) => String(v), 'vs previous period');
    renderKpi('repeatPurchases', activationSummary.repeatPurchases, (v) => String(v), 'vs previous period');
    renderKpi('purchasesReconciled', activationSummary.purchasesReconciled, (v) => String(v), 'vs previous period');

    const rateValueEl = root.querySelector('[data-kpi-checkoutCompletionRate-value]');
    const rateMetaEl = root.querySelector('[data-kpi-checkoutCompletionRate-meta]');
    rateValueEl.textContent = activationSummary.checkoutCompletionRate === null ? '—' : `${activationSummary.checkoutCompletionRate}%`;
    rateMetaEl.textContent = 'of checkout starts in this range';
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
