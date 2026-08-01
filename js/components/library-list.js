/**
 * Robayer WealthLab: My Library Component — Version 3.5.4 (Customer
 * Ownership Experience & Product Page Refinement). Originally built
 * Version 3.1 Milestone M3; this milestone brought it up to the same
 * Owner Mode standard the book detail page already has (V3.5.3) —
 * cover, version, and purchase reference now shown per the brief's own
 * "premium digital bookshelf" spec, plus Read and Review actions that
 * simply didn't exist here before (only Download and View receipt
 * did). Drives dashboard/index.html.
 *
 * Waits for `dashboard:ready` (dashboard-shell.js's own confirmation
 * that a valid session exists — see that file's header comment) before
 * fetching anything, so this component never needs its own 401-handling
 * branch; the shell is the single auth gate. This is a deliberately
 * different gating mechanism from js/components/book-purchase-state.js's
 * own inline session check — not a duplicated ownership check, but the
 * same intentional distinction that file's own header comment already
 * documents: dashboard pages are customer-only by design and may
 * redirect a guest away; the public book detail page never may.
 *
 * The Download/Read actions reuse `POST /api/purchases/:reference/downloads`
 * -> `GET /api/download/:token` exactly as
 * js/components/book-purchase-state.js's own owner actions do on the
 * book detail page — the same one download mechanism, not a second
 * one. Download-limit messaging is shared via
 * js/components/ownership-helpers.js's describeDownloadState() rather
 * than reimplemented here, per this milestone's own architecture-review
 * phase.
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

    // One batched call for every purchase's own-review state, rather
    // than one per row - the same "Leave a Review" -> "Edit Review"
    // label sync js/components/book-purchase-state.js does on the book
    // detail page, reusing the exact same GET /api/customer/reviews
    // endpoint, never a new one.
    let reviewedSlugs = new Set();
    try {
      const reviewData = await window.CustomerDashboard.customerFetch('/api/customer/reviews');
      reviewedSlugs = new Set((reviewData.reviews || []).map((r) => r.productSlug));
    } catch {
      // Non-fatal - every row's review link falls back to "Leave a Review".
    }

    listEl.hidden = false;
    listEl.innerHTML = '';
    result.purchases.forEach((purchase) => listEl.appendChild(renderCard(purchase, reviewedSlugs)));
  }

  function renderCard(purchase, reviewedSlugs) {
    const card = document.createElement('article');
    card.className = 'library-card';

    card.appendChild(renderCover(purchase));

    const meta = document.createElement('div');
    meta.className = 'library-card__meta';

    const title = document.createElement('h2');
    title.className = 'library-card__title';
    title.textContent = purchase.productTitle;
    meta.appendChild(title);

    meta.appendChild(renderStatusBadge(purchase.status));

    const detailsList = document.createElement('dl');
    detailsList.className = 'library-card__details';
    appendDetail(detailsList, 'Purchased', window.RobayerOwnership.formatOwnedDate(purchase.createdAt));
    if (purchase.productVersion) appendDetail(detailsList, 'Version', purchase.productVersion);
    appendDetail(detailsList, 'Reference', purchase.purchaseReference);
    meta.appendChild(detailsList);

    const statusEl = document.createElement('p');
    statusEl.className = 'text-small mt-2 mb-0';
    statusEl.hidden = true;
    statusEl.setAttribute('role', 'status');
    meta.appendChild(statusEl);

    card.appendChild(meta);
    card.appendChild(renderActions(purchase, reviewedSlugs, statusEl));
    return card;
  }

  function renderCover(purchase) {
    const cover = document.createElement('div');
    cover.className = 'library-card__cover book-card__cover book-card__cover--compact';
    if (purchase.coverImageUrl) {
      cover.style.backgroundImage = `url('${purchase.coverImageUrl}')`;
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundPosition = 'center';
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'book-card__cover-placeholder-text';
      placeholder.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'book-card__cover-placeholder-title';
      title.textContent = purchase.productTitle;
      placeholder.appendChild(title);
      cover.appendChild(placeholder);
    }
    return cover;
  }

  function appendDetail(list, label, value) {
    const pair = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    pair.appendChild(dt);
    pair.appendChild(dd);
    list.appendChild(pair);
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
    badge.className = `badge ${info.className} mb-2`;
    badge.textContent = info.label;
    return badge;
  }

  function renderActions(purchase, reviewedSlugs, statusEl) {
    const actions = document.createElement('div');
    actions.className = 'library-card__actions';

    if (purchase.status === 'ready') {
      const ebookAsset = purchase.assets.find((a) => !a.revoked) || null;
      if (ebookAsset) {
        const state = window.RobayerOwnership.describeDownloadState(ebookAsset);

        const readButton = document.createElement('button');
        readButton.type = 'button';
        readButton.className = 'btn btn--accent';
        readButton.textContent = 'Read eBook';
        actions.appendChild(readButton);

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'btn btn--secondary';
        downloadButton.textContent = `Download ${ebookAsset.displayName}`;
        actions.appendChild(downloadButton);

        if (state.limitReached) {
          [readButton, downloadButton].forEach((b) => {
            b.disabled = true;
            b.classList.add('btn--disabled');
          });
          showStatus(statusEl, state.message, 'notice');
        } else {
          readButton.addEventListener('click', () => requestDownload(purchase.purchaseReference, ebookAsset, readButton, downloadButton, statusEl, false));
          downloadButton.addEventListener('click', () => requestDownload(purchase.purchaseReference, ebookAsset, readButton, downloadButton, statusEl, true));
        }

        const reviewLink = document.createElement('a');
        reviewLink.className = 'btn btn--secondary';
        reviewLink.href = `/books/${encodeURIComponent(purchase.productSlug)}/#reviews`;
        reviewLink.textContent = reviewedSlugs.has(purchase.productSlug) ? 'Edit Review' : 'Leave a Review';
        actions.appendChild(reviewLink);
      }
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

  function showStatus(statusEl, message, tone) {
    const ALERT_CLASS = { error: 'alert--error', notice: 'alert--warning' };
    statusEl.classList.remove('alert', 'alert--error', 'alert--warning', 'alert--info');
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.add('alert', ALERT_CLASS[tone] || 'alert--info');
  }

  async function requestDownload(reference, asset, readButton, downloadButton, statusEl, isDownload) {
    showStatus(statusEl, null);
    const activeButton = isDownload ? downloadButton : readButton;
    const defaultLabel = activeButton.textContent;
    [readButton, downloadButton].forEach((b) => (b.disabled = true));
    activeButton.textContent = isDownload ? 'Downloading…' : 'Opening…';

    try {
      const data = await window.CustomerDashboard.customerFetch(`/api/purchases/${encodeURIComponent(reference)}/downloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.assetId }),
      });
      if (isDownload) {
        window.location.href = data.downloadUrl;
      } else {
        window.open(data.downloadUrl, '_blank', 'noopener');
      }
      asset.downloadsUsed += 1;
      const afterState = window.RobayerOwnership.describeDownloadState(asset);
      if (afterState.limitReached) {
        [readButton, downloadButton].forEach((b) => b.classList.add('btn--disabled'));
        showStatus(statusEl, afterState.message, 'notice');
      } else {
        [readButton, downloadButton].forEach((b) => (b.disabled = false));
      }
    } catch (error) {
      const message =
        error.code === 'DOWNLOAD_NOT_AVAILABLE'
          ? window.RobayerOwnership.describeDownloadState(asset).message ||
            'This download is no longer available. If you believe this is an error, please contact support.'
          : error.message || 'Something went wrong. Please refresh and try again.';
      showStatus(statusEl, message, error.code === 'DOWNLOAD_NOT_AVAILABLE' ? 'notice' : 'error');
      [readButton, downloadButton].forEach((b) => (b.disabled = false));
    } finally {
      activeButton.textContent = defaultLabel;
    }
  }

  function showError(message) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message || 'Something went wrong. Please refresh and try again.';
  }
}

document.addEventListener('partials:loaded', initLibraryList);
document.addEventListener('DOMContentLoaded', initLibraryList);
