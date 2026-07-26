/**
 * Robayer WealthLab: Purchase History Component — Version 3.1
 * Milestone M3. Drives dashboard/purchases/index.html.
 *
 * Reads the exact same `GET /api/customer/purchases` data
 * js/components/library-list.js already fetches — per
 * docs/v3.1-m3-ux-strategy.md's own conclusion, Purchase History and
 * My Library are two presentations of one API, not two endpoints. This
 * view emphasizes transaction facts (date, reference, amount, status)
 * over product presentation/download actions.
 */

function initPurchaseHistoryList() {
  const root = document.querySelector('[data-purchase-history-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = root.querySelector('[data-purchase-history-loading]');
  const listEl = root.querySelector('[data-purchase-history-list]');
  const emptyEl = root.querySelector('[data-purchase-history-empty]');
  const errorEl = root.querySelector('[data-purchase-history-error]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50');
    } catch (error) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = error.message || 'Something went wrong. Please refresh and try again.';
      return;
    }

    loadingEl.hidden = true;

    if (result.purchases.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    listEl.hidden = false;
    listEl.innerHTML = '';
    result.purchases.forEach((purchase) => listEl.appendChild(renderRow(purchase)));
  }

  function renderRow(purchase) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const meta = document.createElement('div');
    meta.className = 'library-row__meta';

    const title = document.createElement('h2');
    title.className = 'library-row__title';
    title.textContent = purchase.productTitle;
    meta.appendChild(title);

    const details = document.createElement('p');
    details.className = 'text-secondary text-small';
    details.innerHTML = '';
    const refEl = document.createElement('span');
    refEl.style.fontFamily = 'var(--font-mono)';
    refEl.textContent = purchase.purchaseReference;
    details.appendChild(document.createTextNode(`${formatDate(purchase.createdAt)} • `));
    details.appendChild(refEl);
    details.appendChild(document.createTextNode(` • ${purchase.amountDisplay}`));
    meta.appendChild(details);

    row.appendChild(meta);

    const badge = document.createElement('span');
    const map = {
      ready: { label: 'Ready', className: 'badge--success' },
      processing: { label: 'Processing', className: 'badge--info' },
      refunded: { label: 'Refunded', className: 'badge--warning' },
      unavailable: { label: 'Unavailable', className: 'badge--error' },
    };
    const info = map[purchase.status] || map.unavailable;
    badge.className = `badge ${info.className}`;
    badge.textContent = info.label;
    row.appendChild(badge);

    return row;
  }

  /** Normalizes both `datetime('now')` (SQL) and `toISOString()` formats — see js/components/admin/admin-account.js's own header comment for the exact mixed-format issue this avoids re-discovering. */
  function formatDate(isoString) {
    try {
      const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
      return new Date(normalized).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return isoString;
    }
  }
}

document.addEventListener('partials:loaded', initPurchaseHistoryList);
document.addEventListener('DOMContentLoaded', initPurchaseHistoryList);
