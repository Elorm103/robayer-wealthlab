/**
 * Robayer WealthLab: In-App Reader — Digital Library Phase 7A
 * (Personal Learning Library, Reader Foundation). Drives
 * dashboard/read/index.html.
 *
 * Establishes the real Read/Download split the Phase 7 gap analysis
 * found missing: Read opens the resource here, in this page, rendered
 * client-side with PDF.js (vendored at js/vendor/pdfjs/ — no CDN, no
 * bundler, matching this codebase's existing "no module system for
 * hand-written code" convention; this file is the one deliberate
 * exception, loaded as `type="module"` specifically so it can
 * `import` PDF.js's own ES-module build, while everything it still
 * needs from the rest of the site — window.CustomerDashboard,
 * window.RobayerOwnership — reaches it the same way it reaches every
 * other classic script, since module scripts share the same
 * `window`).
 *
 * The mint-a-token step below (POST /api/purchases/:reference/read-access)
 * is a NEW, separate route, but it calls the exact same
 * generateDownloadPermission() service function real downloads use,
 * with purpose='view' — see backend/routes/purchases.ts's own header
 * comment. Redemption (GET /api/download/:token) is the SAME single
 * endpoint a download already uses; it never increments
 * deliveries.downloads_used for a 'view' token. Reading never costs a
 * download.
 *
 * Fetches the whole PDF as one blob via a single, single-use token
 * redemption (not pdfjsLib's default URL-based range-request loading,
 * which would need the token to be redeemable multiple times) — see
 * the Phase 7 architecture note on why this is the correct approach
 * for a single-use, short-lived token.
 *
 * Digital Library Phase 7B (Personal Reading Experience) — reading
 * position is now real and server-persisted (POST/GET
 * /api/customer/purchases/:reference/progress, requireCustomerAuth,
 * re-verified against this specific customer's entitlement on every
 * call — see backend/services/customer/libraryProgressService.ts).
 * Writes are debounced (~2s after a page change), flushed immediately
 * on completion and on `pagehide`, and a failed write is swallowed —
 * it never interrupts reading. On open, existing progress resumes the
 * document automatically at its saved page, with a small, honest
 * banner naming that and offering "Start from the beginning" instead —
 * never a forced restart, and never a silent jump with no explanation.
 *
 * AI Reading Assistant integration point (Phase 7C, not built here):
 * the natural mount point is inside `.reader-shell`, below
 * `.reader-toolbar` and above `.reader-canvas-wrap` (or a side panel at
 * wider viewports) — at that point in the DOM this file already knows
 * exactly which resource is open (`reference`, `assetId`) and which
 * page is currently rendered (`currentPage`), the two things a
 * resource-scoped assistant needs as grounding context. No UI for it
 * exists yet; do not add a button here that doesn't do anything.
 */

import * as pdfjsLib from '/js/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.mjs';

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.4;
const SCALE_STEP = 0.2;
const DEFAULT_SCALE = 1.1;

function initLibraryReader() {
  const root = document.querySelector('[data-reader-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-reader-loading]');
  const errorEl = document.querySelector('[data-reader-error]');
  const titleEl = document.querySelector('[data-reader-title]');
  const topicEl = document.querySelector('[data-reader-topic]');
  const shellEl = document.querySelector('[data-reader-shell]');
  const unsupportedEl = document.querySelector('[data-reader-unsupported]');
  const canvasWrap = document.querySelector('[data-reader-canvas-wrap]');
  const canvas = document.querySelector('[data-reader-canvas]');
  const pageIndicatorEl = document.querySelector('[data-reader-page-indicator]');
  const progressFillEl = document.querySelector('[data-reader-progress-fill]');
  const prevBtn = document.querySelector('[data-reader-prev-page]');
  const nextBtn = document.querySelector('[data-reader-next-page]');
  const zoomInBtn = document.querySelector('[data-reader-zoom-in]');
  const zoomOutBtn = document.querySelector('[data-reader-zoom-out]');
  const fallbackDownloadBtn = document.querySelector('[data-reader-fallback-download]');
  const resumeBannerEl = document.querySelector('[data-reader-resume-banner]');
  const resumeBannerTextEl = document.querySelector('[data-reader-resume-text]');
  const resumeRestartBtn = document.querySelector('[data-reader-resume-restart]');

  const TOPIC_LABELS = {
    investing: 'Investing',
    'personal-finance': 'Personal Finance',
    budgeting: 'Budgeting',
    business: 'Business',
    mindset: 'Mindset',
  };

  const PROGRESS_WRITE_DEBOUNCE_MS = 2000;

  let pdfDoc = null;
  let currentPage = 1;
  let scale = DEFAULT_SCALE;
  let rendering = false;
  let currentReference = null;
  let currentAssetId = null;
  let progressWriteTimer = null;
  let completionAlreadyReported = false;

  document.addEventListener('dashboard:ready', load, { once: true });

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    return { reference: params.get('ref'), assetId: params.get('assetId') };
  }

  async function load() {
    const { reference, assetId } = getQueryParams();
    if (!reference || !assetId) {
      showError('This reading link is missing information. Please open a resource from My Library.');
      return;
    }

    let purchases;
    try {
      const result = await window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50');
      purchases = result.purchases || [];
    } catch (error) {
      showError(error.message);
      return;
    }

    const purchase = purchases.find((p) => p.purchaseReference === reference);
    if (!purchase || purchase.status !== 'ready') {
      showError('This resource could not be found in your library. If you believe this is an error, please contact support.');
      return;
    }

    const asset = (purchase.assets || []).find((a) => a.assetId === assetId);
    if (!asset || asset.revoked) {
      showError("This purchase's files are no longer available. If you believe this is an error, please contact support.");
      return;
    }

    loadingEl.hidden = true;
    root.hidden = false;
    titleEl.textContent = purchase.productTitle;
    if (purchase.topic && TOPIC_LABELS[purchase.topic]) {
      topicEl.textContent = TOPIC_LABELS[purchase.topic];
      topicEl.hidden = false;
    }
    document.title = `${purchase.productTitle} | Robayer WealthLab`;

    currentReference = reference;
    currentAssetId = assetId;

    // Digital Library Phase 7C (AI Reading Assistant) — the one
    // integration point between the reader and the AI panel
    // (js/components/library-ai-panel.js), a deliberately separate
    // component per this codebase's one-script-per-concern convention.
    // Event-based, not a shared module or global mutable state: the
    // panel only ever learns the resource/book title and whether it's
    // a supported format from this one dispatch, and the current page
    // from the page-changed event fired on every render below.
    document.dispatchEvent(
      new CustomEvent('library-reader:ready', {
        detail: { purchaseReference: reference, assetId, bookTitle: purchase.productTitle, supportsAi: asset.fileType === 'PDF' },
      })
    );

    if (asset.fileType !== 'PDF') {
      unsupportedEl.hidden = false;
      wireFallbackDownload(reference, asset);
      return;
    }

    shellEl.hidden = false;

    // A single, fast, indexed lookup - checked before minting the read
    // token so the resume decision is known before the first page ever
    // renders (avoiding a page-1 flash before jumping to the saved
    // page). Failure here is silent and non-fatal: worst case, the
    // customer just starts at page 1 with no resume banner, exactly
    // like a first-time open.
    let savedProgress = null;
    try {
      const result = await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(reference)}/progress?assetId=${encodeURIComponent(assetId)}`
      );
      savedProgress = result.progress;
    } catch {
      savedProgress = null;
    }

    await openReadSession(reference, asset, savedProgress);
  }

  function wireFallbackDownload(reference, asset) {
    fallbackDownloadBtn.addEventListener('click', async () => {
      fallbackDownloadBtn.disabled = true;
      const defaultLabel = fallbackDownloadBtn.textContent;
      fallbackDownloadBtn.textContent = 'Preparing…';
      try {
        const data = await window.CustomerDashboard.customerFetch(`/api/purchases/${encodeURIComponent(reference)}/downloads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: asset.assetId }),
        });
        window.location.href = data.downloadUrl;
      } catch (error) {
        showError(error.message || 'Could not start the download. Please try again, or use My Library.');
      } finally {
        fallbackDownloadBtn.disabled = false;
        fallbackDownloadBtn.textContent = defaultLabel;
      }
    });
  }

  /**
   * Mints a 'view' token, redeems it in one shot as a blob (so the
   * single-use token is only ever consumed once, regardless of how
   * many pages PDF.js subsequently renders from the in-memory
   * document it already has), and hands that blob to PDF.js.
   */
  async function openReadSession(reference, asset, savedProgress) {
    let readUrl;
    try {
      const permission = await window.CustomerDashboard.customerFetch(`/api/purchases/${encodeURIComponent(reference)}/read-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.assetId }),
      });
      readUrl = permission.readUrl;
    } catch (error) {
      showError(error.message || 'This resource could not be opened right now. Please try again.');
      return;
    }

    let response;
    try {
      response = await fetch(readUrl);
    } catch {
      showError('Could not reach the server. Please check your connection and try again.');
      return;
    }
    if (!response.ok) {
      showError('This resource could not be opened right now. Please try again, or use My Library.');
      return;
    }

    // The blob URL is deliberately NOT revoked right after getDocument()
    // resolves - PDF.js reads from it lazily, per page, not all upfront
    // into memory. Revoking it that early breaks every page beyond the
    // first (confirmed directly: page 1 renders fine from data already
    // buffered while establishing numPages, but page 2 needs a fresh
    // read from the URL and silently fails once it's revoked). Instead
    // it's released on `pagehide` - this page is a single-document
    // session, so "the customer is done with this blob" and "the
    // customer is leaving this page" are the same moment.
    let blobUrl;
    try {
      const blob = await response.blob();
      blobUrl = URL.createObjectURL(blob);
      window.addEventListener('pagehide', () => URL.revokeObjectURL(blobUrl));
      pdfDoc = await pdfjsLib.getDocument(blobUrl).promise;
    } catch {
      showError('This file could not be displayed. Please try again, or download it instead from My Library.');
      return;
    }

    // Resume decision: only jump to a saved page if it's genuinely
    // still a valid, in-progress position in THIS document - a stale
    // currentPage beyond the real page count (e.g. the file changed)
    // just falls back to page 1 rather than erroring.
    const canResume =
      savedProgress &&
      savedProgress.status !== 'completed' &&
      typeof savedProgress.currentPage === 'number' &&
      savedProgress.currentPage > 1 &&
      savedProgress.currentPage <= pdfDoc.numPages;

    currentPage = canResume ? savedProgress.currentPage : 1;
    if (canResume && savedProgress.currentPage >= pdfDoc.numPages) completionAlreadyReported = true;
    wireControls();
    window.addEventListener('pagehide', flushProgressOnUnload);
    await renderPage(currentPage);

    if (canResume) {
      resumeBannerTextEl.textContent = `Resumed — page ${savedProgress.currentPage} of ${pdfDoc.numPages}.`;
      resumeBannerEl.hidden = false;
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        goToPage(1);
      });
    }
  }

  function wireControls() {
    prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
    nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    zoomInBtn.addEventListener('click', () => setScale(scale + SCALE_STEP));
    zoomOutBtn.addEventListener('click', () => setScale(scale - SCALE_STEP));

    canvasWrap.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') goToPage(currentPage + 1);
      if (event.key === 'ArrowLeft') goToPage(currentPage - 1);
    });

    // Digital Library Phase 7C — a citation in the AI panel is a real,
    // substantiated page reference (see answerService.ts's own
    // grounding guarantee); clicking one should genuinely take the
    // reader there, not just claim to.
    document.addEventListener('library-ai-panel:go-to-page', (event) => goToPage(event.detail.pageNumber));
  }

  function goToPage(page) {
    if (!pdfDoc || page < 1 || page > pdfDoc.numPages || rendering) return;
    currentPage = page;
    renderPage(currentPage);
  }

  function setScale(next) {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (pdfDoc) renderPage(currentPage);
  }

  async function renderPage(pageNumber) {
    rendering = true;
    prevBtn.disabled = pageNumber <= 1;
    nextBtn.disabled = pageNumber >= pdfDoc.numPages;

    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: context, viewport }).promise;

    pageIndicatorEl.textContent = `Page ${pageNumber} of ${pdfDoc.numPages}`;
    progressFillEl.style.width = `${Math.round((pageNumber / pdfDoc.numPages) * 100)}%`;
    rendering = false;

    scheduleProgressWrite(pageNumber, pdfDoc.numPages);
    document.dispatchEvent(new CustomEvent('library-reader:page-changed', { detail: { currentPage: pageNumber, totalPages: pdfDoc.numPages } }));
  }

  /**
   * Debounced by design - a customer flipping through several pages in
   * quick succession should produce one write, not one per page. The
   * final page (completion) always writes immediately: it is the one
   * event worth confirming without delay, and it only ever fires once
   * per session (completionAlreadyReported guards a customer sitting on
   * the last page and re-triggering a render, e.g. via zoom).
   */
  function scheduleProgressWrite(pageNumber, totalPages) {
    if (progressWriteTimer) clearTimeout(progressWriteTimer);

    if (pageNumber >= totalPages) {
      if (!completionAlreadyReported) {
        completionAlreadyReported = true;
        writeProgress(pageNumber, totalPages);
      }
      return;
    }

    progressWriteTimer = setTimeout(() => writeProgress(pageNumber, totalPages), PROGRESS_WRITE_DEBOUNCE_MS);
  }

  /**
   * A failed write is swallowed on purpose - reading must never stop,
   * error, or even visibly hesitate because a progress save didn't go
   * through. The next successful page-change write simply supersedes
   * it; nothing about this being a background, best-effort operation
   * is shown to the customer.
   */
  async function writeProgress(currentPageValue, totalPagesValue) {
    try {
      await window.CustomerDashboard.customerFetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: currentAssetId, currentPage: currentPageValue, totalPages: totalPagesValue }),
      });
    } catch {
      // Silent by design - see this function's own header comment.
    }
  }

  /**
   * Guarantees the LATEST position is saved even if the debounce timer
   * from the most recent page change hasn't fired yet when the
   * customer navigates away. Unconditional (not gated on a pending
   * timer) - it's a cheap, idempotent safety net, and correctly
   * detecting "is there truly an unflushed change" isn't worth the
   * extra state for what is, at worst, one redundant write of the
   * already-current page. `keepalive` lets the request outlive the
   * page; a plain customerFetch() call would be aborted by navigation
   * before it completes. CSRF header attached manually - customerFetch()
   * doesn't support `keepalive`, so this bypasses it for this one call
   * while keeping the same header convention dashboard-auth.js uses.
   */
  function flushProgressOnUnload() {
    if (!pdfDoc) return;
    if (progressWriteTimer) clearTimeout(progressWriteTimer);
    const csrf = window.CustomerDashboard.getCsrfToken();
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Customer-CSRF-Token'] = csrf;
    fetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ assetId: currentAssetId, currentPage, totalPages: pdfDoc.numPages }),
      keepalive: true,
    }).catch(() => {});
  }

  function showError(message) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = message || 'Something went wrong. Please refresh and try again.';
  }
}

document.addEventListener('partials:loaded', initLibraryReader);
document.addEventListener('DOMContentLoaded', initLibraryReader);
