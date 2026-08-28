/**
 * Robayer WealthLab: My Library Component — Digital Library
 * Modernization (Phase 5), building on Version 3.5.4's "premium
 * digital bookshelf" foundation. Drives dashboard/index.html.
 *
 * New in this pass, per the approved Phase 1-4 report: a warm welcome
 * header (using only real, session-derived data — no invented name,
 * since no display name is ever collected anywhere in this codebase's
 * signup flow, confirmed during the audit), topic-based grouping using
 * the real products.topic taxonomy (now returned by
 * GET /api/customer/purchases), client-side search and sort, a
 * proactive downloads-used/remaining line per asset, and a redesigned
 * discovery empty state. Recommendations ("Continue your learning")
 * are a separate, independent component — see library-recommendations.js
 * — matching this codebase's established one-script-per-section
 * convention (js/components/admin/admin-live-activity.js et al.).
 *
 * Waits for `dashboard:ready` (dashboard-shell.js's own confirmation
 * that a valid session exists) before fetching anything, so this
 * component never needs its own 401-handling branch.
 *
 * The Download/Read actions reuse `POST /api/purchases/:reference/downloads`
 * -> `GET /api/download/:token` exactly as before — the same one
 * download mechanism, not a second one. Download-limit messaging is
 * shared via js/components/ownership-helpers.js's describeDownloadState().
 */

const TOPIC_LABELS = {
  investing: 'Investing',
  'personal-finance': 'Personal Finance',
  budgeting: 'Budgeting',
  business: 'Business',
  mindset: 'Mindset',
};
const TOPIC_ORDER = ['investing', 'personal-finance', 'budgeting', 'business', 'mindset'];

function initLibraryList() {
  const root = document.querySelector('[data-library-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-library-loading]');
  const listEl = root.querySelector('[data-library-list]');
  const emptyEl = document.querySelector('[data-library-empty]');
  const errorEl = document.querySelector('[data-library-error]');
  const welcomeHeaderEl = document.querySelector('[data-library-welcome-header]');
  const welcomeSubEl = document.querySelector('[data-library-welcome-sub]');
  const toolbarEl = document.querySelector('[data-library-toolbar]');
  const searchInput = document.querySelector('[data-library-search]');
  const sortSelect = document.querySelector('[data-library-sort]');
  const downloadInfoPanel = document.querySelector('[data-download-info-panel]');

  let allPurchases = [];
  let reviewedSlugs = new Set();

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
      renderEmptyState();
      return;
    }

    allPurchases = result.purchases;

    try {
      const reviewData = await window.CustomerDashboard.customerFetch('/api/customer/reviews');
      reviewedSlugs = new Set((reviewData.reviews || []).map((r) => r.productSlug));
    } catch {
      // Non-fatal - every row's review link falls back to "Leave a Review".
    }

    populateWelcome(allPurchases);
    if (toolbarEl) toolbarEl.hidden = false;
    if (downloadInfoPanel) downloadInfoPanel.hidden = false;

    root.hidden = false;
    renderLibrary();

    if (searchInput) searchInput.addEventListener('input', renderLibrary);
    if (sortSelect) sortSelect.addEventListener('change', renderLibrary);
  }

  /**
   * Real, computed counts only - resources owned and the number of
   * distinct real topics among them. No streaks, no percentages, no
   * fabricated activity, per the brief's explicit instruction and the
   * Phase 1-4 audit's confirmation that no such data exists anywhere
   * in this system.
   */
  function populateWelcome(purchases) {
    if (!welcomeSubEl) return;
    const topics = new Set(purchases.map((p) => p.topic).filter(Boolean));
    const resourceWord = purchases.length === 1 ? 'resource' : 'resources';
    if (topics.size > 1) {
      welcomeSubEl.textContent = `You own ${purchases.length} ${resourceWord} across ${topics.size} topics. Here is everything, ready when you are.`;
    } else {
      welcomeSubEl.textContent = `You own ${purchases.length} ${resourceWord}. Here is everything, ready when you are.`;
    }
  }

  function getFilteredSortedPurchases() {
    const query = (searchInput && searchInput.value.trim().toLowerCase()) || '';
    const sortMode = (sortSelect && sortSelect.value) || 'recent';

    let purchases = allPurchases;
    if (query) {
      purchases = purchases.filter((p) => p.productTitle.toLowerCase().includes(query));
    }

    const sorted = purchases.slice();
    if (sortMode === 'alphabetical') {
      sorted.sort((a, b) => a.productTitle.localeCompare(b.productTitle));
    } else if (sortMode === 'accessed') {
      sorted.sort((a, b) => lastAccessedAt(b) - lastAccessedAt(a));
    }
    // 'recent' - the API already returns purchases newest-first; no
    // client-side re-sort needed, preserving the server's own order.
    return { purchases: sorted, isFiltered: Boolean(query) };
  }

  /** Real signal: the Read action increments the exact same downloadsUsed/lastDownloadAt as Download, so this genuinely reflects the last time the customer opened or downloaded the file, never an estimate. */
  function lastAccessedAt(purchase) {
    const timestamps = (purchase.assets || [])
      .map((a) => a.lastDownloadAt)
      .filter(Boolean)
      .map((t) => new Date(t.includes('T') ? t : t.replace(' ', 'T') + 'Z').getTime());
    if (timestamps.length === 0) return new Date(purchase.createdAt.includes('T') ? purchase.createdAt : purchase.createdAt.replace(' ', 'T') + 'Z').getTime();
    return Math.max(...timestamps);
  }

  function renderLibrary() {
    const { purchases, isFiltered } = getFilteredSortedPurchases();
    listEl.innerHTML = '';

    if (purchases.length === 0) {
      const noResults = document.createElement('p');
      noResults.className = 'text-secondary';
      noResults.textContent = 'Nothing matches that search.';
      listEl.appendChild(noResults);
      return;
    }

    if (isFiltered || (sortSelect && sortSelect.value !== 'recent')) {
      // A deliberate search or a non-default sort reads as "show me
      // exactly this, in this order" - topic headers would just add
      // noise on top of an already-specific request.
      const group = document.createElement('div');
      group.className = 'library-group__cards';
      purchases.forEach((purchase) => group.appendChild(renderCard(purchase, reviewedSlugs)));
      listEl.appendChild(group);
      return;
    }

    const byTopic = new Map();
    const untopiced = [];
    purchases.forEach((purchase) => {
      if (purchase.topic && TOPIC_LABELS[purchase.topic]) {
        if (!byTopic.has(purchase.topic)) byTopic.set(purchase.topic, []);
        byTopic.get(purchase.topic).push(purchase);
      } else {
        untopiced.push(purchase);
      }
    });

    TOPIC_ORDER.forEach((topic) => {
      const items = byTopic.get(topic);
      if (!items || items.length === 0) return; // never render an empty topic section
      listEl.appendChild(renderTopicGroup(TOPIC_LABELS[topic], items));
    });
    if (untopiced.length > 0) {
      listEl.appendChild(renderTopicGroup('More resources', untopiced));
    }
  }

  function renderTopicGroup(label, purchases) {
    const section = document.createElement('section');
    section.className = 'library-group';
    const heading = document.createElement('h2');
    heading.className = 'library-group__heading';
    heading.textContent = label;
    section.appendChild(heading);
    const cards = document.createElement('div');
    cards.className = 'library-group__cards';
    purchases.forEach((purchase) => cards.appendChild(renderCard(purchase, reviewedSlugs)));
    section.appendChild(cards);
    return section;
  }

  function renderCard(purchase, reviewedSlugs) {
    const card = document.createElement('article');
    card.className = 'library-card';

    card.appendChild(renderCover(purchase));

    const meta = document.createElement('div');
    meta.className = 'library-card__meta';

    const title = document.createElement('h3');
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

  /** Proactive "used / remaining" line, shown only while the asset is still comfortably usable - once the limit is reached, describeDownloadState()'s own warning message takes over instead, so the two never talk over each other. Purely informational; downloadsRemaining is never trusted for anything but display (the atomic check in entitlementService.ts is the real enforcement, unchanged). */
  function renderDownloadUsage(asset) {
    if (asset.maxDownloads === null) return null;
    const remaining = asset.downloadsRemaining ?? Math.max(0, asset.maxDownloads - asset.downloadsUsed);
    if (remaining <= 0) return null;
    const line = document.createElement('p');
    line.className = 'text-small text-muted mt-2 mb-0';
    line.textContent = `${asset.downloadsUsed} of ${asset.maxDownloads} downloads used, ${remaining} remaining.`;
    return line;
  }

  function renderActions(purchase, reviewedSlugs, statusEl) {
    const wrap = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'library-card__actions';

    if (purchase.status === 'ready') {
      const ebookAsset = purchase.assets.find((a) => !a.revoked) || null;
      if (ebookAsset) {
        const state = window.RobayerOwnership.describeDownloadState(ebookAsset);

        const readButton = document.createElement('button');
        readButton.type = 'button';
        readButton.className = 'btn btn--accent library-card__action-primary';
        readButton.textContent = 'Read eBook';
        readButton.setAttribute('data-library-read-action', '');
        actions.appendChild(readButton);

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'btn btn--secondary';
        downloadButton.textContent = `Download ${ebookAsset.displayName}`;
        downloadButton.setAttribute('data-library-download-action', '');
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

        wrap.appendChild(actions);
        const usageLine = renderDownloadUsage(ebookAsset);
        if (usageLine) wrap.appendChild(usageLine);
      } else {
        wrap.appendChild(actions);
      }
    } else {
      wrap.appendChild(actions);
    }

    if (purchase.receiptNumber) {
      const link = document.createElement('a');
      link.className = 'btn btn--secondary';
      link.href = `/api/customer/receipts/${encodeURIComponent(purchase.receiptNumber)}/download`;
      link.textContent = 'View receipt';
      actions.appendChild(link);
    }

    return wrap;
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
      if (asset.maxDownloads !== null) asset.downloadsRemaining = Math.max(0, asset.maxDownloads - asset.downloadsUsed);
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

  /**
   * A real, invitation-shaped discovery surface instead of one flat
   * sentence - "You haven't built your WealthLab yet," then a small
   * set of featured/bestseller products. Reuses the existing public
   * GET /api/products endpoint (no auth needed, already used elsewhere
   * on public pages) rather than a new backend surface. If that fetch
   * fails for any reason, degrades to the plain "Browse our guides"
   * link already in the static HTML - never a broken-looking page.
   */
  async function renderEmptyState() {
    // The empty state carries its own "You haven't built your
    // WealthLab yet" heading, which would read as a contradiction
    // right underneath "Everything you own, in one place" - the
    // generic welcome header steps aside for this state.
    if (welcomeHeaderEl) welcomeHeaderEl.hidden = true;
    emptyEl.hidden = false;
    const picksEl = emptyEl.querySelector('[data-library-empty-picks]');
    if (!picksEl) return;
    try {
      const data = await fetch('/api/products?featured=true&pageSize=3').then((r) => r.json());
      const items = (data && data.data && data.data.items) || [];
      if (items.length === 0) return;
      picksEl.hidden = false;
      items.forEach((product) => picksEl.appendChild(renderEmptyStatePick(product)));
    } catch {
      // The static "Browse our guides" link already in the HTML covers this - no error state needed for a nice-to-have.
    }
  }

  function renderEmptyStatePick(product) {
    const card = document.createElement('a');
    card.className = 'library-empty-pick';
    card.href = `/books/${encodeURIComponent(product.slug)}/`;
    const cover = document.createElement('div');
    cover.className = 'library-empty-pick__cover book-card__cover book-card__cover--compact';
    if (product.coverImage) {
      cover.style.backgroundImage = `url('${product.coverImage}')`;
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundPosition = 'center';
    }
    const title = document.createElement('p');
    title.className = 'library-empty-pick__title';
    title.textContent = product.title;
    card.appendChild(cover);
    card.appendChild(title);
    return card;
  }

  function showError(message) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message || 'Something went wrong. Please refresh and try again.';
  }
}

document.addEventListener('partials:loaded', initLibraryList);
document.addEventListener('DOMContentLoaded', initLibraryList);
