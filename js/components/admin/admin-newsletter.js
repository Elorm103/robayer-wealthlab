/**
 * Robayer WealthLab — Newsletter Campaigns list, Version 2.1 Phase 6.
 * Drives admin/newsletter/index.html: campaign history table with
 * live delivery-summary counts, matching the observability fields
 * required by the approved design (created by/sent by/dates/recipient
 * counts/status).
 */

const CAMPAIGNS_API_BASE = '/api/admin/newsletter/campaigns';

const STATUS_LABELS = { draft: 'Draft', sending: 'Sending', sent: 'Sent', failed: 'Failed' };
const STATUS_BADGE_CLASS = { draft: '', sending: 'badge--warning', sent: 'badge--success', failed: 'badge--error' };

function initAdminNewsletter() {
  const root = document.querySelector('[data-campaigns-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-campaigns-load-error]'),
    subscribedCount: root.querySelector('[data-campaigns-subscribed-count]'),
    empty: root.querySelector('[data-campaigns-empty]'),
    tableWrap: root.querySelector('[data-campaigns-table-wrap]'),
    tableBody: root.querySelector('[data-campaigns-table-body]'),
  };

  load();

  async function load() {
    els.loadError.hidden = true;
    try {
      const [campaigns, subscribed] = await Promise.all([
        window.AdminAuth.adminFetch(CAMPAIGNS_API_BASE),
        window.AdminAuth.adminFetch(`${CAMPAIGNS_API_BASE}/subscribed-count`),
      ]);
      els.subscribedCount.textContent = `${subscribed.subscribedCount} subscribed recipient${subscribed.subscribedCount === 1 ? '' : 's'}`;
      render(campaigns);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load campaigns.';
      els.loadError.hidden = false;
    }
  }

  function formatDate(isoString) {
    if (!isoString) return '—';
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function render(campaigns) {
    if (campaigns.length === 0) {
      els.empty.hidden = false;
      els.tableWrap.hidden = true;
      return;
    }
    els.empty.hidden = true;
    els.tableWrap.hidden = false;

    els.tableBody.innerHTML = campaigns
      .map((c) => {
        const deliveryText = c.status === 'draft' ? '—' : `${c.delivery.sent} sent, ${c.delivery.failed} failed, ${c.delivery.skipped} skipped`;
        return `
          <tr>
            <td><a href="/admin/newsletter/edit/?id=${c.id}">${escapeHtml(c.subject)}</a></td>
            <td><span class="badge ${STATUS_BADGE_CLASS[c.status] || ''}">${STATUS_LABELS[c.status] || c.status}</span></td>
            <td>${c.createdByName ? escapeHtml(c.createdByName) : '—'}</td>
            <td>${c.sentByName ? escapeHtml(c.sentByName) : '—'}</td>
            <td>${formatDate(c.createdAt)}</td>
            <td>${formatDate(c.sentAt)}</td>
            <td>${c.intendedRecipientCount ?? '—'}</td>
            <td>${deliveryText}</td>
            <td><a href="/admin/newsletter/edit/?id=${c.id}" class="btn btn--secondary">View</a></td>
          </tr>
        `;
      })
      .join('');
  }
}

document.addEventListener('partials:loaded', initAdminNewsletter);
