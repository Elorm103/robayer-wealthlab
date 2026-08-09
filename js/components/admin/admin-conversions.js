/**
 * Robayer WealthLab — Conversion tracking (Meta Pixel + Conversions
 * API) admin section. Version 5.0 (Customer Acquisition Phase 1,
 * Phase 10). Drives the [data-conversion-root] card appended to
 * admin/analytics/index.html, via
 * GET /api/admin/analytics/conversion-dispatch.
 *
 * A second, independent script on the shared analytics admin page —
 * same convention js/components/admin/admin-traffic.js already
 * established, not a modification of admin-analytics.js. Not
 * date-range-scoped (pixel health, the retry queue, and failed events
 * are current-state facts, not a period comparison), so this
 * deliberately does not listen to the page's date-range toolbar.
 */

const CONVERSION_API = '/api/admin/analytics/conversion-dispatch';

function initAdminConversions() {
  const root = document.querySelector('[data-conversion-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-conversion-load-error]'),
    status: root.querySelector('[data-conversion-status]'),
    statusMeta: root.querySelector('[data-conversion-status-meta]'),
    lastSent: root.querySelector('[data-conversion-last-sent]'),
    retryQueue: root.querySelector('[data-conversion-retry-queue]'),
    failedEmpty: root.querySelector('[data-conversion-failed-empty]'),
    failedWrap: root.querySelector('[data-conversion-failed-table-wrap]'),
    failedBody: root.querySelector('[data-conversion-failed-body]'),
    purchasesEmpty: root.querySelector('[data-conversion-purchases-empty]'),
    purchasesWrap: root.querySelector('[data-conversion-purchases-table-wrap]'),
    purchasesBody: root.querySelector('[data-conversion-purchases-body]'),
    leadsEmpty: root.querySelector('[data-conversion-leads-empty]'),
    leadsWrap: root.querySelector('[data-conversion-leads-table-wrap]'),
    leadsBody: root.querySelector('[data-conversion-leads-body]'),
    downloadsEmpty: root.querySelector('[data-conversion-downloads-empty]'),
    downloadsWrap: root.querySelector('[data-conversion-downloads-table-wrap]'),
    downloadsBody: root.querySelector('[data-conversion-downloads-body]'),
  };

  refresh();

  async function refresh() {
    els.loadError.hidden = true;

    try {
      const data = await window.AdminAuth.adminFetch(CONVERSION_API);
      renderStatus(data.providers);
      els.retryQueue.textContent = String(data.retryQueueCount);

      renderTable(els.failedEmpty, els.failedWrap, els.failedBody, data.failedEvents, (row) => [
        `${row.eventName} #${row.id}`,
        row.provider,
        row.status.replace('_', ' '),
        String(row.attemptCount),
        row.lastError ? row.lastError.slice(0, 120) : '—',
        formatDateTime(row.createdAt),
      ]);

      renderTable(els.purchasesEmpty, els.purchasesWrap, els.purchasesBody, data.recentPurchasesSent, (row) => [
        row.provider,
        row.status,
        formatDateTime(row.sentAt || row.createdAt),
      ]);

      renderTable(els.leadsEmpty, els.leadsWrap, els.leadsBody, data.recentLeads, (row) => [
        row.source,
        row.email,
        formatDateTime(row.createdAt),
      ]);

      renderTable(els.downloadsEmpty, els.downloadsWrap, els.downloadsBody, data.recentDownloads, (row) => [
        row.productSlug,
        row.assetId,
        formatDateTime(row.usedAt),
      ]);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load conversion tracking data.';
      els.loadError.hidden = false;
    }
  }

  function renderStatus(providers) {
    const meta = providers && providers[0];
    if (!meta) {
      els.status.textContent = 'Not configured';
      els.statusMeta.textContent = '';
      els.lastSent.textContent = '—';
      return;
    }

    els.status.textContent = meta.configured ? 'Active' : 'Not configured';
    els.statusMeta.textContent = meta.configured
      ? `${meta.provider} — ${meta.recentFailureCount} failure${meta.recentFailureCount === 1 ? '' : 's'} in the last 24h`
      : `Set META_CAPI_ACCESS_TOKEN (wrangler secret) to activate ${meta.provider}.`;
    els.lastSent.textContent = meta.lastEventSentAt ? formatDateTime(meta.lastEventSentAt) : 'Never';
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
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value.endsWith('Z') || value.includes('+') ? value : value + 'Z');
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

document.addEventListener('partials:loaded', initAdminConversions);
