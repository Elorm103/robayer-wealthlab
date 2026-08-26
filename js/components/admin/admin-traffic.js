/**
 * Robayer WealthLab — Traffic & funnel section (Version 4.0 Milestone A,
 * Measurement Foundation; extended by the Analytics & User-Activity
 * Baseline for device/country, and by the Reliable Sales Funnel
 * Measurement pass for source breakdown). Drives the [data-traffic-root]
 * card in admin/analytics/index.html: most-viewed pages, most-clicked
 * CTAs, traffic sources, newsletter signups by source, free-guide
 * lead-magnet funnel, device/country breakdown, and a normalized
 * source breakdown (sessions/product views/checkout starts/purchases/
 * revenue per channel) — from the analytics_events table (migration
 * 0025/0045/0046) plus the pre-existing newsletter_subscribers.source
 * column, via GET /api/admin/dashboard/traffic and GET
 * /api/admin/analytics/devices|geography|sources. Per-book funnel
 * (views/checkouts/purchases/revenue/downloads) lives in the PRODUCTS
 * section instead (admin-products-funnel.js) — see
 * services/admin/analyticsService.ts's getPerBookFunnel() for why.
 *
 * Reuses the page's existing date-range toolbar ([data-analytics-preset],
 * [data-analytics-date-from/to]) instead of adding a second one — this is
 * a second, independent script listening to the same controls, not a
 * modification of admin-analytics.js, matching this project's convention
 * of small independent per-section scripts on shared admin pages.
 */

const TRAFFIC_API = '/api/admin/dashboard/traffic';

function initAdminTraffic() {
  const root = document.querySelector('[data-traffic-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const dateFrom = document.querySelector('[data-analytics-date-from]');
  const dateTo = document.querySelector('[data-analytics-date-to]');
  const presetChips = Array.from(document.querySelectorAll('[data-analytics-preset]'));

  const els = {
    loadError: root.querySelector('[data-traffic-load-error]'),
    pagesEmpty: root.querySelector('[data-traffic-pages-empty]'),
    pagesWrap: root.querySelector('[data-traffic-pages-wrap]'),
    pagesBody: root.querySelector('[data-traffic-pages-body]'),
    ctasEmpty: root.querySelector('[data-traffic-ctas-empty]'),
    ctasWrap: root.querySelector('[data-traffic-ctas-wrap]'),
    ctasBody: root.querySelector('[data-traffic-ctas-body]'),
    sourcesEmpty: root.querySelector('[data-traffic-sources-empty]'),
    sourcesWrap: root.querySelector('[data-traffic-sources-wrap]'),
    sourcesBody: root.querySelector('[data-traffic-sources-body]'),
    newsletterEmpty: root.querySelector('[data-traffic-newsletter-empty]'),
    newsletterWrap: root.querySelector('[data-traffic-newsletter-wrap]'),
    newsletterBody: root.querySelector('[data-traffic-newsletter-body]'),
    leadMagnet: root.querySelector('[data-traffic-lead-magnet]'),
    devicesEmpty: root.querySelector('[data-traffic-devices-empty]'),
    devicesWrap: root.querySelector('[data-traffic-devices-wrap]'),
    devicesBody: root.querySelector('[data-traffic-devices-body]'),
    geoEmpty: root.querySelector('[data-traffic-geo-empty]'),
    geoWrap: root.querySelector('[data-traffic-geo-wrap]'),
    geoBody: root.querySelector('[data-traffic-geo-body]'),
    // Admin Analytics Dashboard v2 moved Source Breakdown out of the
    // [data-traffic-root] card into its own Section 4 card, so these
    // four are document-scoped, not root-scoped, unlike every other
    // element above.
    sourceBreakdownEmpty: document.querySelector('[data-traffic-source-breakdown-empty]'),
    sourceBreakdownWrap: document.querySelector('[data-traffic-source-breakdown-wrap]'),
    sourceBreakdownBody: document.querySelector('[data-traffic-source-breakdown-body]'),
    sourceBreakdownSortButtons: Array.from(document.querySelectorAll('[data-traffic-source-breakdown-sort]')),
  };

  /** Admin Analytics Dashboard v2 — kept so column-header sorting can re-render without a second fetch; 'revenuePesewas' descending on load, matching the backend's own default ORDER BY. */
  let lastSourceRows = [];
  let sourceSortKey = 'revenuePesewas';
  let sourceSortDir = 'desc';

  refresh();
  presetChips.forEach((chip) => chip.addEventListener('click', () => refresh()));
  if (dateFrom) dateFrom.addEventListener('change', refresh);
  if (dateTo) dateTo.addEventListener('change', refresh);
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  els.sourceBreakdownSortButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-traffic-source-breakdown-sort');
      sourceSortDir = sourceSortKey === key && sourceSortDir === 'desc' ? 'asc' : 'desc';
      sourceSortKey = key;
      renderSourceBreakdown();
    });
  });

  /** Mirrors admin-analytics.js's own buildParams() — "All time" clears the date inputs and sets a flag the backend recognizes rather than a huge literal date range, so every script sharing this toolbar needs the same check. */
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
    els.loadError.hidden = true;
    const params = buildParams();

    try {
      const [data, devices, geo, sources] = await Promise.all([
        window.AdminAuth.adminFetch(`${TRAFFIC_API}?${params.toString()}`),
        window.AdminAuth.adminFetch(`/api/admin/analytics/devices?${params.toString()}`),
        window.AdminAuth.adminFetch(`/api/admin/analytics/geography?${params.toString()}`),
        window.AdminAuth.adminFetch(`/api/admin/analytics/sources?${params.toString()}`),
      ]);
      renderTable(els.pagesEmpty, els.pagesWrap, els.pagesBody, data.pageViewsByPath, (row) => [row.pagePath, String(row.views)]);
      renderTable(els.ctasEmpty, els.ctasWrap, els.ctasBody, data.ctaClicksById, (row) => [row.ctaId, String(row.clicks)]);
      renderTable(els.sourcesEmpty, els.sourcesWrap, els.sourcesBody, data.trafficSources, (row) => [row.source, String(row.sessions)]);
      renderTable(els.newsletterEmpty, els.newsletterWrap, els.newsletterBody, data.newsletterSignupsBySource, (row) => [row.source, String(row.signups)]);
      renderTable(els.devicesEmpty, els.devicesWrap, els.devicesBody, devices.items, (row) => [row.label, String(row.count)]);
      renderTable(els.geoEmpty, els.geoWrap, els.geoBody, geo.items, (row) => [row.label, String(row.count)]);
      lastSourceRows = sources.items;
      renderSourceBreakdown();
      renderLeadMagnet(data.leadMagnetFunnel);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load traffic data.';
      els.loadError.hidden = false;
    }
  }

  function renderTable(emptyEl, wrapEl, bodyEl, rows, toCells) {
    const hasRows = rows && rows.length > 0;
    emptyEl.hidden = hasRows;
    wrapEl.hidden = !hasRows;
    if (!hasRows) return;

    bodyEl.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      toCells(row).forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      bodyEl.appendChild(tr);
    });
  }

  /**
   * Admin Analytics Dashboard v2 — Section 4 (Traffic Sources).
   * Conversion is purchases/sessions, the same "of everyone this
   * channel sent us, how many bought" definition the Sales Funnel
   * section uses site-wide, computed here per source instead. "—"
   * when sessions is 0, never a fabricated 0% or a divide-by-zero.
   */
  function renderSourceBreakdown() {
    const rows = [...lastSourceRows].sort((a, b) => {
      const av = sourceSortKey === 'conversionRate' ? conversionRate(a) ?? -1 : a[sourceSortKey];
      const bv = sourceSortKey === 'conversionRate' ? conversionRate(b) ?? -1 : b[sourceSortKey];
      if (typeof av === 'string') return sourceSortDir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
      return sourceSortDir === 'desc' ? bv - av : av - bv;
    });

    els.sourceBreakdownSortButtons.forEach((button) => {
      const key = button.getAttribute('data-traffic-source-breakdown-sort');
      button.setAttribute('aria-sort', key === sourceSortKey ? (sourceSortDir === 'desc' ? 'descending' : 'ascending') : 'none');
    });

    renderTable(els.sourceBreakdownEmpty, els.sourceBreakdownWrap, els.sourceBreakdownBody, rows, (row) => {
      const rate = conversionRate(row);
      return [
        row.source,
        String(row.sessions),
        String(row.productViews),
        String(row.checkoutStarts),
        String(row.purchases),
        formatCurrency(row.revenuePesewas / 100),
        rate === null ? '—' : `${rate}%`,
      ];
    });
  }

  function conversionRate(row) {
    return row.sessions > 0 ? Math.round((row.purchases / row.sessions) * 1000) / 10 : null;
  }

  function renderLeadMagnet(funnel) {
    const clicks = funnel.ctaClicks;
    const signups = funnel.freeGuideSignups;
    const rate = clicks > 0 ? Math.round((signups / clicks) * 100) : null;
    els.leadMagnet.textContent = rate === null
      ? `${signups} free-guide signup${signups === 1 ? '' : 's'} in this range (no featured-resource CTA clicks recorded to compare against).`
      : `${clicks} featured-resource CTA click${clicks === 1 ? '' : 's'} → ${signups} free-guide signup${signups === 1 ? '' : 's'} (${rate}%).`;
  }
}

/** Same GH₵ formatting convention as admin-products-funnel.js's own formatCurrency() — a small local copy per independent script, not a shared utility. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

document.addEventListener('partials:loaded', initAdminTraffic);
