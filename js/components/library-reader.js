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
// Phase 9A (Reader Readability) — replaces the old fixed DEFAULT_SCALE.
// A single constant scale looked fine on the desktop widths it was
// tuned against and forced constant pinching on a phone, because the
// canvas's *displayed* size used to be capped by CSS `max-width:100%`
// regardless of this value anyway (see components.css's own comment on
// the canvas rule) - scale genuinely changing the display size (this
// file's other Phase 9A change) makes a fixed default wrong for most
// screens. computeFitScale() below replaces it with a real "fit this
// page to the available width" calculation, recomputed on load and on
// resize/orientation-change.
const RESIZE_DEBOUNCE_MS = 150;

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
  let scale = null; // set on first render via computeFitScale() — see that function's own comment
  let lastFitScale = null; // the most recent fit-to-width value, see setScale()'s own comment on why manual zoom-out needs this
  let rendering = false;
  let resizeTimer = null;
  let currentReference = null;
  let currentAssetId = null;
  let currentProductSlug = null;
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
    currentProductSlug = purchase.productSlug;

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
        detail: { purchaseReference: reference, assetId, productSlug: purchase.productSlug, bookTitle: purchase.productTitle, supportsAi: asset.fileType === 'PDF' },
      })
    );

    // Phase 8 (Digital Library Observability) — fires once the reader
    // has a confirmed, owned book to show, mirroring how the site's own
    // trackProductView() fires once a book-detail page confirms its
    // slug (js/components/analytics.js). Fires for every format,
    // including the honest-unsupported EPUB path below - "opened the
    // reader for this book" is true either way.
    if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-reader-opened', purchase.productSlug);

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
      // Phase 8 — the banner appearing IS the resume already having
      // happened (currentPage was already set to the saved page above,
      // before this render); there's no separate "accept" click in this
      // UI, only an opt-out. "Acceptance" is computed downstream as
      // shown-minus-restarted, so this pair of events is the complete,
      // honest signal - firing a redundant "accepted" event equal to
      // "shown" here would add no real information.
      if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-shown', currentProductSlug);
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-restarted', currentProductSlug);
        goToPage(1);
      });
    }
  }

  function wireControls() {
    prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
    nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    // Phase 9A — guarded on `scale !== null`: wireControls() runs
    // fractionally before the first renderPage() call resolves and
    // sets an initial fit-to-width scale (see that call site below), a
    // pre-existing ordering this file already had; a click in that
    // narrow window now no-ops instead of computing off a null scale.
    zoomInBtn.addEventListener('click', () => { if (scale !== null) setScale(scale + SCALE_STEP); });
    zoomOutBtn.addEventListener('click', () => { if (scale !== null) setScale(scale - SCALE_STEP); });

    canvasWrap.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') goToPage(currentPage + 1);
      if (event.key === 'ArrowLeft') goToPage(currentPage - 1);
    });

    // Digital Library Phase 7C — a citation in the AI panel is a real,
    // substantiated page reference (see answerService.ts's own
    // grounding guarantee); clicking one should genuinely take the
    // reader there, not just claim to.
    document.addEventListener('library-ai-panel:go-to-page', (event) => goToPage(event.detail.pageNumber));

    // Phase 9A — re-fit to the available width on resize/orientation-
    // change (e.g. rotating a phone), not just on first load. Debounced
    // so a window drag re-renders once at the end, not on every
    // intermediate pixel.
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refitAndRerender, RESIZE_DEBOUNCE_MS);
    });
  }

  function goToPage(page) {
    if (!pdfDoc || page < 1 || page > pdfDoc.numPages || rendering) return;
    currentPage = page;
    renderPage(currentPage);
  }

  /**
   * Phase 9A — the zoom-out floor is `Math.min(MIN_SCALE, lastFitScale)`,
   * not a bare MIN_SCALE: a real bug found during UX verification. On a
   * genuinely narrow phone (confirmed at 320-390px against a standard-
   * width PDF), the fit-to-width scale is already below MIN_SCALE by
   * design (see computeFitScale()'s own comment) - clamping a manual
   * zoom-OUT click to the higher, fixed MIN_SCALE floor made the page
   * jump LARGER on the first zoom-out press, the opposite of what the
   * button does everywhere else. The floor now always admits at least
   * the current fit scale, so zoom-out never moves the wrong direction.
   */
  function setScale(next) {
    const floor = lastFitScale === null ? MIN_SCALE : Math.min(MIN_SCALE, lastFitScale);
    scale = Math.min(MAX_SCALE, Math.max(floor, next));
    if (pdfDoc) renderPage(currentPage);
  }

  /** Phase 9A — the CSS-pixel width actually available for the page to fill: clientWidth already includes padding, so it's subtracted back out. computeFitScale() divides this into the page's own unscaled width. */
  function getWrapContentWidth() {
    const style = window.getComputedStyle(canvasWrap);
    const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return Math.max(200, canvasWrap.clientWidth - paddingX);
  }

  /**
   * Phase 9A — "fit this page to the available width," replacing the
   * old fixed DEFAULT_SCALE constant. `unscaledWidth` is the page's own
   * real width at scale=1 (pdf.js's own unit); dividing the space
   * actually available by it gives the scale that fills that width
   * exactly.
   *
   * Deliberately clamped only against MAX_SCALE, never MIN_SCALE - a
   * real bug found during Phase 9 UX verification: MIN_SCALE=0.6
   * exists to stop a customer from manually zooming a page out to
   * illegible smallness (setScale() below still enforces it for that),
   * but reusing it here as a floor on the FIT calculation forced
   * needless horizontal overflow at the supposedly-"fitted" default on
   * any viewport narrower than ~415px against a standard-width PDF -
   * confirmed live at 320/375/390px, three of the most common real
   * phone widths. "Fits with zero overflow" must always win over an
   * unrelated manual-zoom floor; getWrapContentWidth()'s own
   * Math.max(200, ...) is what keeps this from ever going unreasonably
   * small.
   */
  function computeFitScale(unscaledWidth) {
    const fit = Math.min(MAX_SCALE, getWrapContentWidth() / unscaledWidth);
    lastFitScale = fit;
    return fit;
  }

  /** Phase 9A — resize/orientation-change handler: recomputes the fit-to-width scale for the new available width and re-renders at it, same calculation as the initial load. */
  async function refitAndRerender() {
    if (!pdfDoc || rendering) return;
    const page = await pdfDoc.getPage(currentPage);
    scale = computeFitScale(page.getViewport({ scale: 1 }).width);
    renderPage(currentPage);
  }

  async function renderPage(pageNumber) {
    rendering = true;
    prevBtn.disabled = pageNumber <= 1;
    nextBtn.disabled = pageNumber >= pdfDoc.numPages;

    const page = await pdfDoc.getPage(pageNumber);
    if (scale === null) scale = computeFitScale(page.getViewport({ scale: 1 }).width);

    // Phase 9A — two viewports, deliberately: `viewport` is the
    // logical, CSS-pixel size the canvas is DISPLAYED at
    // (canvas.style.width/height) - a real change here is what makes
    // zoom in/out and the fit-to-width default actually change the
    // visible size, now that components.css's canvas rule no longer
    // overrides it with `max-width:100%`. `renderViewport`, scaled
    // additionally by devicePixelRatio, is the higher INTRINSIC pixel
    // resolution (canvas.width/height) PDF.js actually draws into -
    // this is what keeps text crisp on Retina/high-DPI screens instead
    // of the canvas's own pixels being upscaled/blurred by the browser.
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });
    const renderViewport = page.getViewport({ scale: scale * dpr });
    const context = canvas.getContext('2d');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    await page.render({ canvasContext: context, viewport: renderViewport }).promise;

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
