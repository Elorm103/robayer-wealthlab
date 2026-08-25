/**
 * Robayer WealthLab — Traffic & funnel section (Version 4.0 Milestone A,
 * Measurement Foundation; extended by the Analytics & User-Activity
 * Baseline for device/country). Drives the [data-traffic-root] card
 * in admin/analytics/index.html: most-viewed pages, most-clicked CTAs,
 * traffic sources, newsletter signups by source, free-guide lead-magnet
 * funnel, and device/country breakdown — from the analytics_events
 * table (migration 0025/0045) plus the pre-existing
 * newsletter_subscribers.source column, via GET /api/admin/dashboard/traffic
 * and GET /api/admin/analytics/devices|geography. Per-book funnel
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
  };

  refresh();
  presetChips.forEach((chip) => chip.addEventListener('click', () => refresh()));
  if (dateFrom) dateFrom.addEventListener('change', refresh);
  if (dateTo) dateTo.addEventListener('change', refresh);

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
      const [data, devices, geo] = await Promise.all([
        window.AdminAuth.adminFetch(`${TRAFFIC_API}?${params.toString()}`),
        window.AdminAuth.adminFetch(`/api/admin/analytics/devices?${params.toString()}`),
        window.AdminAuth.adminFetch(`/api/admin/analytics/geography?${params.toString()}`),
      ]);
      renderTable(els.pagesEmpty, els.pagesWrap, els.pagesBody, data.pageViewsByPath, (row) => [row.pagePath, String(row.views)]);
      renderTable(els.ctasEmpty, els.ctasWrap, els.ctasBody, data.ctaClicksById, (row) => [row.ctaId, String(row.clicks)]);
      renderTable(els.sourcesEmpty, els.sourcesWrap, els.sourcesBody, data.trafficSources, (row) => [row.source, String(row.sessions)]);
      renderTable(els.newsletterEmpty, els.newsletterWrap, els.newsletterBody, data.newsletterSignupsBySource, (row) => [row.source, String(row.signups)]);
      renderTable(els.devicesEmpty, els.devicesWrap, els.devicesBody, devices.items, (row) => [row.label, String(row.count)]);
      renderTable(els.geoEmpty, els.geoWrap, els.geoBody, geo.items, (row) => [row.label, String(row.count)]);
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

  function renderLeadMagnet(funnel) {
    const clicks = funnel.ctaClicks;
    const signups = funnel.freeGuideSignups;
    const rate = clicks > 0 ? Math.round((signups / clicks) * 100) : null;
    els.leadMagnet.textContent = rate === null
      ? `${signups} free-guide signup${signups === 1 ? '' : 's'} in this range (no featured-resource CTA clicks recorded to compare against).`
      : `${clicks} featured-resource CTA click${clicks === 1 ? '' : 's'} → ${signups} free-guide signup${signups === 1 ? '' : 's'} (${rate}%).`;
  }
}

document.addEventListener('partials:loaded', initAdminTraffic);
