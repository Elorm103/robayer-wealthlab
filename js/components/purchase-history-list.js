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

  /**
   * Version 3.6 (Platform Hardening, Phase 3 — Dashboard UI
   * Consistency) - the labeled Purchased/Reference/Amount strip below
   * reuses .library-card__details/dt/dd exactly as introduced for the
   * Customer Library in V3.5.4, rather than a second hand-rolled
   * "label above value" style for this page. The single run-on
   * sentence this replaced (date bullet reference bullet amount) is
   * gone; the underlying data and fields are unchanged. The outer
   * .library-row container itself is deliberately kept (not switched
   * to .library-card): its border/radius/padding/background are
   * already identical to .library-card's, and this page has no cover
   * image to justify .library-card's two-column grid — reusing the
   * correct existing variant for a page with no cover, not inventing
   * a third pattern.
   */
  function renderRow(purchase) {
    const row = document.createElement('div');
    row.className = 'library-row';

    const meta = document.createElement('div');
    meta.className = 'library-row__meta';

    const title = document.createElement('h2');
    title.className = 'library-card__title';
    title.textContent = purchase.productTitle;
    meta.appendChild(title);

    const map = {
      ready: { label: 'Ready', className: 'badge--success' },
      processing: { label: 'Processing', className: 'badge--info' },
      refunded: { label: 'Refunded', className: 'badge--warning' },
      unavailable: { label: 'Unavailable', className: 'badge--error' },
    };
    const info = map[purchase.status] || map.unavailable;
    const badge = document.createElement('span');
    badge.className = `badge ${info.className} mb-2`;
    badge.textContent = info.label;
    meta.appendChild(badge);

    const details = document.createElement('dl');
    details.className = 'library-card__details';
    appendDetail(details, 'Purchased', formatDate(purchase.createdAt));
    appendDetail(details, 'Reference', purchase.purchaseReference);
    appendDetail(details, 'Amount', purchase.amountDisplay);
    meta.appendChild(details);

    row.appendChild(meta);
    return row;
  }

  function appendDetail(list, label, value) {
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.style.fontFamily = label === 'Reference' ? 'var(--font-mono)' : '';
    dd.textContent = value;
    pair.appendChild(dt);
    pair.appendChild(dd);
    list.appendChild(pair);
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
