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
  /** Digital Library Phase 7B — keyed `${purchaseReference}:${assetId}`, populated in load(). Absent entries render no progress line at all, never a fabricated "not started" badge. */
  let progressByKey = new Map();

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

    try {
      const progressData = await window.CustomerDashboard.customerFetch('/api/customer/library/progress');
      progressByKey = new Map((progressData.progress || []).map((p) => [`${p.purchaseReference}:${p.assetId}`, p]));
    } catch {
      // Non-fatal - cards simply show no progress line, same as a genuinely first-time-open resource.
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

  /**
   * Phase 6.1 fix: the proactive "used / remaining" line's text is
   * computed here, in one place, and reused both at initial render
   * (renderActions() below) and after a live download succeeds
   * (requestDownload() below) - never duplicated. Returns null once
   * the asset is unlimited or the limit is reached; describeDownloadState()'s
   * own warning message takes over at that point instead, so the two
   * never talk over each other. Purely informational; downloadsRemaining
   * is never trusted for anything but display (the atomic check in
   * entitlementService.ts is the real enforcement, unchanged).
   */
  function computeDownloadUsageText(asset) {
    if (asset.maxDownloads === null) return null;
    const remaining = asset.downloadsRemaining ?? Math.max(0, asset.maxDownloads - asset.downloadsUsed);
    if (remaining <= 0) return null;
    return `${asset.downloadsUsed} of ${asset.maxDownloads} downloads used, ${remaining} remaining.`;
  }

  /** Phase 6.1 fix: re-reads the same, already-mutated asset object requestDownload() just updated, and either updates the existing usage line in place or removes it once the limit is reached - so the displayed count can never go stale after a live download the way it did before this fix. No-op if this card never had a usage line to begin with (an unlimited asset never gains one). */
  function refreshDownloadUsageLine(usageLine, asset) {
    if (!usageLine) return;
    const text = computeDownloadUsageText(asset);
    if (text) {
      usageLine.textContent = text;
    } else {
      usageLine.remove();
    }
  }

  /**
   * Phase 9C.6 (EPUB Library Availability & Production Integration) —
   * a purchase's non-revoked assets can now be more than one (e.g. a
   * PDF and an EPUB edition of the same book, once both are published
   * and entitled), so a card's format label needs to distinguish them.
   * `fileType` is the same free-text column product_files.file_type
   * already carries (see backend/database/migrations/0008); only the
   * two real formats today get a clean uppercase label, anything else
   * falls back to the asset's own display name rather than showing a
   * raw/unexpected fileType string.
   */
  function assetFormatLabel(asset) {
    const type = (asset.fileType || '').toUpperCase();
    if (type === 'PDF' || type === 'EPUB') return type;
    return asset.displayName || type || 'File';
  }

  function renderActions(purchase, reviewedSlugs, statusEl) {
    const wrap = document.createElement('div');
    // Phase 6.1 fix: the existing `.library-card__actions { grid-column: 1 / -1; }`
    // rule only ever applied to a direct child of the `.library-card` grid
    // container. Wrapping it in this outer div (originally added so the
    // downloads-used line could sit alongside it) silently turned it into
    // a grandchild, so the rule stopped doing anything - every card's
    // actions and usage line were squeezed into the 96px cover column at
    // every width from 641px up. This wrapper now carries the spanning
    // rule itself instead.
    wrap.className = 'library-card__actions-wrap';

    const actions = document.createElement('div');
    actions.className = 'library-card__actions';

    let usageLine = null;

    if (purchase.status === 'ready') {
      // Phase 9C.6: the pre-existing bug this replaces was
      // `purchase.assets.find((a) => !a.revoked)` - picking exactly one
      // owned asset even when the backend correctly returned several
      // (e.g. PDF + EPUB). A product with only one owned asset renders
      // through the exact same single-asset markup/wording as before
      // (byte-identical - no regression for the PDF-only catalog that
      // exists today); two or more owned assets is the new, real path.
      const ownedAssets = purchase.assets.filter((a) => !a.revoked);
      const ebookAsset = ownedAssets[0] || null;

      if (ownedAssets.length > 1) {
        // Digital Library Phase 7A's Read link (real navigation to
        // dashboard/read/, never a download-count-consuming action) and
        // Download button behavior are unchanged per-asset - only the
        // rendering loops over every owned format now, grouped as
        // "every Read button, then every Download button" per this
        // phase's UX requirement, so a customer immediately sees they
        // own both formats rather than reading it off a dropdown.
        const usageLines = [];
        const progressEls = [];

        ownedAssets.forEach((asset) => {
          const state = window.RobayerOwnership.describeDownloadState(asset);
          const label = assetFormatLabel(asset);

          const readButton = document.createElement('a');
          readButton.className = 'btn btn--accent library-card__action-primary';
          readButton.textContent = `Read ${label}`;
          readButton.setAttribute('data-library-read-action', '');
          readButton.href = `/dashboard/read/?ref=${encodeURIComponent(purchase.purchaseReference)}&assetId=${encodeURIComponent(asset.assetId)}`;
          if (state.revoked) {
            readButton.setAttribute('aria-disabled', 'true');
            readButton.tabIndex = -1;
            readButton.removeAttribute('href');
            readButton.classList.add('btn--disabled');
          }
          actions.appendChild(readButton);
        });

        ownedAssets.forEach((asset) => {
          const state = window.RobayerOwnership.describeDownloadState(asset);
          const label = assetFormatLabel(asset);

          const downloadButton = document.createElement('button');
          downloadButton.type = 'button';
          downloadButton.className = 'btn btn--secondary';
          downloadButton.textContent = `Download ${label}`;
          downloadButton.setAttribute('data-library-download-action', '');

          let assetUsageLine = null;
          if (state.limitReached) {
            downloadButton.disabled = true;
            downloadButton.classList.add('btn--disabled');
            showStatus(statusEl, state.message, 'notice');
          } else {
            downloadButton.addEventListener('click', () =>
              requestDownload(purchase.purchaseReference, asset, downloadButton, statusEl, assetUsageLine)
            );
          }
          actions.appendChild(downloadButton);

          const usageText = computeDownloadUsageText(asset);
          if (usageText) {
            assetUsageLine = document.createElement('p');
            assetUsageLine.className = 'text-small text-muted mt-2 mb-0';
            assetUsageLine.textContent = `${label}: ${usageText}`;
            usageLines.push(assetUsageLine);
          }

          const progress = progressByKey.get(`${purchase.purchaseReference}:${asset.assetId}`);
          const progressEl = renderProgressLine(progress);
          if (progressEl) progressEls.push(progressEl);
        });

        const reviewLink = document.createElement('a');
        reviewLink.className = 'btn btn--secondary';
        reviewLink.href = `/books/${encodeURIComponent(purchase.productSlug)}/#reviews`;
        reviewLink.textContent = reviewedSlugs.has(purchase.productSlug) ? 'Edit Review' : 'Leave a Review';
        actions.appendChild(reviewLink);

        wrap.appendChild(actions);
        usageLines.forEach((el) => wrap.appendChild(el));
        progressEls.forEach((el) => wrap.appendChild(el));
      } else if (ebookAsset) {
        const state = window.RobayerOwnership.describeDownloadState(ebookAsset);

        // Digital Library Phase 7A: Read is a real navigation to the
        // in-app reader (dashboard/read/), not a click handler that
        // mints a download - see js/components/library-reader.js. It
        // never calls requestDownload() below, so it never touches
        // downloadsUsed at all; the reader page mints its own,
        // separate, non-consuming 'view' token. Gated only on
        // `revoked` (ownership itself), never on the download limit -
        // per the Phase 7 product model, reading does not draw from
        // the download count, so a customer who has exhausted their
        // downloads can still read what they own.
        const readButton = document.createElement('a');
        readButton.className = 'btn btn--accent library-card__action-primary';
        readButton.textContent = 'Read eBook';
        readButton.setAttribute('data-library-read-action', '');
        readButton.href = `/dashboard/read/?ref=${encodeURIComponent(purchase.purchaseReference)}&assetId=${encodeURIComponent(ebookAsset.assetId)}`;
        actions.appendChild(readButton);

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'btn btn--secondary';
        downloadButton.textContent = `Download ${ebookAsset.displayName}`;
        downloadButton.setAttribute('data-library-download-action', '');
        actions.appendChild(downloadButton);

        if (state.revoked) {
          readButton.setAttribute('aria-disabled', 'true');
          readButton.tabIndex = -1;
          readButton.removeAttribute('href');
          readButton.classList.add('btn--disabled');
        }
        if (state.limitReached) {
          downloadButton.disabled = true;
          downloadButton.classList.add('btn--disabled');
          showStatus(statusEl, state.message, 'notice');
        } else {
          // usageLine is resolved inside this closure at click time, not
          // definition time - by then it already holds whatever element
          // (or null) the render below assigns it, so requestDownload()
          // always refreshes the real, current line for this card.
          downloadButton.addEventListener('click', () => requestDownload(purchase.purchaseReference, ebookAsset, downloadButton, statusEl, usageLine));
        }

        const reviewLink = document.createElement('a');
        reviewLink.className = 'btn btn--secondary';
        reviewLink.href = `/books/${encodeURIComponent(purchase.productSlug)}/#reviews`;
        reviewLink.textContent = reviewedSlugs.has(purchase.productSlug) ? 'Edit Review' : 'Leave a Review';
        actions.appendChild(reviewLink);

        wrap.appendChild(actions);
        const usageText = computeDownloadUsageText(ebookAsset);
        if (usageText) {
          usageLine = document.createElement('p');
          usageLine.className = 'text-small text-muted mt-2 mb-0';
          usageLine.textContent = usageText;
          wrap.appendChild(usageLine);
        }

        const progress = progressByKey.get(`${purchase.purchaseReference}:${ebookAsset.assetId}`);
        const progressEl = renderProgressLine(progress);
        if (progressEl) wrap.appendChild(progressEl);
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

  /**
   * Digital Library Phase 7B — the Library card's own learning-progress
   * signal, real and server-persisted (see js/components/library-reader.js
   * and backend/services/customer/libraryProgressService.ts). Returns
   * null for `not_started` or no progress row at all - a resource
   * nobody has opened yet gets no extra line, never a fabricated
   * "0% complete."
   */
  function renderProgressLine(progress) {
    if (!progress || progress.status === 'not_started') return null;

    if (progress.status === 'completed') {
      const badge = document.createElement('p');
      badge.className = 'library-card__completed-badge mb-0';
      badge.textContent = 'Completed';
      return badge;
    }

    const wrap = document.createElement('div');
    wrap.className = 'library-card__progress';

    const meta = document.createElement('p');
    meta.className = 'library-card__progress-meta';
    meta.textContent = `Continue reading — Page ${progress.currentPage} of ${progress.totalPages}`;
    wrap.appendChild(meta);

    const track = document.createElement('div');
    track.className = 'library-card__progress-track';
    const fill = document.createElement('div');
    fill.className = 'library-card__progress-track-fill';
    fill.style.width = `${progress.percentComplete}%`;
    track.appendChild(fill);
    wrap.appendChild(track);

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

  /**
   * Digital Library Phase 7A: this is now the Download-only path -
   * Read is a plain navigation (see renderActions() above) and never
   * calls this function, so it never reaches asset.downloadsUsed at
   * all. Everything below is otherwise unchanged from before Phase 7A:
   * same endpoint, same atomic entitlement enforcement, same usage-
   * line refresh.
   */
  async function requestDownload(reference, asset, downloadButton, statusEl, usageLine) {
    showStatus(statusEl, null);
    const defaultLabel = downloadButton.textContent;
    downloadButton.disabled = true;
    downloadButton.textContent = 'Downloading…';

    try {
      const data = await window.CustomerDashboard.customerFetch(`/api/purchases/${encodeURIComponent(reference)}/downloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.assetId }),
      });
      window.location.href = data.downloadUrl;
      asset.downloadsUsed += 1;
      if (asset.maxDownloads !== null) asset.downloadsRemaining = Math.max(0, asset.maxDownloads - asset.downloadsUsed);
      // Phase 6.1 fix: the displayed "used / remaining" line was never
      // refreshed after a successful download, so it kept showing the
      // pre-download count until the page was reloaded. Reads the exact
      // same, just-mutated asset object above - never a second, separate
      // calculation of remaining downloads.
      refreshDownloadUsageLine(usageLine, asset);
      const afterState = window.RobayerOwnership.describeDownloadState(asset);
      if (afterState.limitReached) {
        downloadButton.classList.add('btn--disabled');
        showStatus(statusEl, afterState.message, 'notice');
      } else {
        downloadButton.disabled = false;
      }
    } catch (error) {
      const message =
        error.code === 'DOWNLOAD_NOT_AVAILABLE'
          ? window.RobayerOwnership.describeDownloadState(asset).message ||
            'This download is no longer available. If you believe this is an error, please contact support.'
          : error.message || 'Something went wrong. Please refresh and try again.';
      showStatus(statusEl, message, error.code === 'DOWNLOAD_NOT_AVAILABLE' ? 'notice' : 'error');
      downloadButton.disabled = false;
    } finally {
      downloadButton.textContent = defaultLabel;
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
