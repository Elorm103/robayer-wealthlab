/**
 * Robayer WealthLab: Receipts Component — Version 3.1 Milestone M3.
 * Drives dashboard/receipts/index.html.
 *
 * The download action hits `GET /api/customer/receipts/:receiptNumber/download`
 * directly as a real link — no mint-then-redeem step needed for this
 * authenticated path (the session itself is the authorization), unlike
 * the guest reference-scoped flow — see
 * docs/v3.1-m3-api-gap-analysis.md's "Reusable endpoints" table.
 */

function initReceiptsList() {
  const root = document.querySelector('[data-receipts-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = root.querySelector('[data-receipts-loading]');
  const listEl = root.querySelector('[data-receipts-list]');
  const emptyEl = root.querySelector('[data-receipts-empty]');
  const errorEl = root.querySelector('[data-receipts-error]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/receipts');
    } catch (error) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = error.message || 'Something went wrong. Please refresh and try again.';
      return;
    }

    loadingEl.hidden = true;

    if (result.receipts.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    listEl.hidden = false;
    listEl.innerHTML = '';
    result.receipts.forEach((receipt) => listEl.appendChild(renderRow(receipt)));
  }

  /** Version 3.6 (Platform Hardening, Phase 3 — Dashboard UI Consistency) - see purchase-history-list.js's own header comment on this same change: the labeled detail strip and actions row now reuse .library-card__details/.library-card__actions exactly as established for the Customer Library in V3.5.4, rather than a page-specific style. Same data, same one action, no workflow change. */
  function renderRow(receipt) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const meta = document.createElement('div');
    meta.className = 'library-row__meta';

    const title = document.createElement('h2');
    title.className = 'library-card__title';
    title.textContent = receipt.productTitle;
    meta.appendChild(title);

    const details = document.createElement('dl');
    details.className = 'library-card__details';
    appendDetail(details, 'Receipt', receipt.receiptNumber);
    appendDetail(details, 'Issued', formatDate(receipt.issuedAt));
    appendDetail(details, 'Total', receipt.totalDisplay);
    meta.appendChild(details);

    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'library-card__actions';
    const link = document.createElement('a');
    link.className = 'btn btn--accent';
    link.href = `/api/customer/receipts/${encodeURIComponent(receipt.receiptNumber)}/download`;
    link.textContent = 'Download PDF';
    actions.appendChild(link);
    row.appendChild(actions);

    return row;
  }

  function appendDetail(list, label, value) {
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.style.fontFamily = label === 'Receipt' ? 'var(--font-mono)' : '';
    dd.textContent = value;
    pair.appendChild(dt);
    pair.appendChild(dd);
    list.appendChild(pair);
  }

  /** Normalizes both `datetime('now')` (SQL) and `toISOString()` formats — see js/components/admin/admin-account.js's own header comment for the exact mixed-format issue this avoids re-discovering. */
  function formatDate(isoString) {
    try {
      const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
      return new Date(normalized).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return isoString;
    }
  }
}

document.addEventListener('partials:loaded', initReceiptsList);
document.addEventListener('DOMContentLoaded', initReceiptsList);
