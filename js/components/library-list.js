/**
 * Robayer WealthLab: My Library Component — Version 3.1 Milestone M3
 * (Checkout Auto-Provisioning & Dashboard MVP). Drives dashboard/index.html.
 *
 * Waits for `dashboard:ready` (dashboard-shell.js's own confirmation
 * that a valid session exists — see that file's header comment) before
 * fetching anything, so this component never needs its own 401-handling
 * branch; the shell is the single auth gate.
 *
 * The Download action reuses `POST /api/purchases/:reference/downloads`
 * -> `GET /api/download/:token` exactly as
 * js/components/fulfilment-status.js's own `requestDownload()` already
 * does (mint a fresh single-use token at click time, then a direct
 * navigation — the response *is* the file) — per
 * docs/v3.1-m3-api-gap-analysis.md's own "this endpoint is already
 * reusable from an authenticated context with no change" finding, this
 * is not a second download mechanism, it is the same one.
 */

function initLibraryList() {
  const root = document.querySelector('[data-library-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = root.querySelector('[data-library-loading]');
  const listEl = root.querySelector('[data-library-list]');
  const emptyEl = root.querySelector('[data-library-empty]');
  const errorEl = root.querySelector('[data-library-error]');

  document.addEventListener('dashboard:ready', load, { once: true });

  async function load() {
    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50');
    } catch (error) {
      showError(error.message);
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
    const row = document.createElement('article');
    row.className = 'library-row';

    const meta = document.createElement('div');
    meta.className = 'library-row__meta';

    const title = document.createElement('h2');
    title.className = 'library-row__title';
    title.textContent = purchase.productTitle;
    meta.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'text-secondary text-small';
    sub.textContent = `Purchased ${formatDate(purchase.createdAt)} • ${purchase.amountDisplay}`;
    meta.appendChild(sub);

    meta.appendChild(renderStatusBadge(purchase.status));

    if (purchase.status === 'ready' && purchase.assets.length > 0) {
      const usage = purchase.assets
        .filter((asset) => !asset.revoked)
        .map((asset) => usageLine(asset))
        .join(' ');
      if (usage) {
        const usageEl = document.createElement('p');
        usageEl.className = 'library-row__usage';
        usageEl.textContent = usage;
        meta.appendChild(usageEl);
      }
    }

    row.appendChild(meta);
    row.appendChild(renderActions(purchase));
    return row;
  }

  function usageLine(asset) {
    if (asset.downloadsUsed === 0) return '';
    const limit = asset.maxDownloads === null ? '' : ` of ${asset.maxDownloads}`;
    return `Downloaded ${asset.downloadsUsed}${limit} time${asset.downloadsUsed === 1 ? '' : 's'}${asset.lastDownloadAt ? `, last on ${formatDate(asset.lastDownloadAt)}` : ''}.`;
  }

  function renderStatusBadge(status) {
    const map = {
      ready: { label: 'Ready', className: 'badge--success' },
      processing: { label: 'Processing', className: 'badge--info' },
      refunded: { label: 'Refunded', className: 'badge--warning' },
      unavailable: { label: 'Unavailable', className: 'badge--error' },
    };
    const info = map[status] || map.unavailable;
    const badge = document.createElement('span');
    badge.className = `badge ${info.className}`;
    badge.textContent = info.label;
    return badge;
  }

  function renderActions(purchase) {
    const actions = document.createElement('div');
    actions.className = 'library-row__actions';

    if (purchase.status === 'ready') {
      purchase.assets
        .filter((asset) => !asset.revoked)
        .forEach((asset) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn--accent';
          button.textContent = `Download ${asset.displayName}`;
          button.addEventListener('click', () => requestDownload(purchase.purchaseReference, asset.assetId, button));
          actions.appendChild(button);
        });
    }

    if (purchase.receiptNumber) {
      const link = document.createElement('a');
      link.className = 'btn btn--secondary';
      link.href = `/api/customer/receipts/${encodeURIComponent(purchase.receiptNumber)}/download`;
      link.textContent = 'View receipt';
      actions.appendChild(link);
    }

    return actions;
  }

  async function requestDownload(reference, assetId, button) {
    clearError();
    const defaultLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing…';

    try {
      const data = await window.CustomerDashboard.customerFetch(`/api/purchases/${encodeURIComponent(reference)}/downloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      window.location.href = data.downloadUrl;
      button.textContent = defaultLabel;
      button.disabled = false;
    } catch (error) {
      showError(error.message);
      button.textContent = defaultLabel;
      button.disabled = false;
    }
  }

  /** Normalizes both `datetime('now')` (SQL, space-separated, no timezone) and `new Date().toISOString()` (already `T`/`Z`) — see js/components/admin/admin-account.js's own header comment for the exact mixed-format issue this avoids re-discovering. */
  function formatDate(isoString) {
    try {
      const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
      return new Date(normalized).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return isoString;
    }
  }

  function showError(message) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message || 'Something went wrong. Please refresh and try again.';
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
}

document.addEventListener('partials:loaded', initLibraryList);
document.addEventListener('DOMContentLoaded', initLibraryList);
