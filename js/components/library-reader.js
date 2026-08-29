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
// Phase 9A follow-up (Reader Readability, round 2) — a real gap found
// after shipping fit-to-width: fitting a standard document-page-width
// PDF (Letter/A4, ~10.5-12pt body text - confirmed against actual
// Library books, not assumed) into a phone-width wrap produces
// legible-on-paper-but-not-on-screen text (~5-8px effective at
// 320-430px, measured directly). Fit-to-width alone cannot fix this -
// the page and the phone screen are just different shapes - so the
// default scale now also guarantees at least this many CSS pixels of
// actual body-text height, even if that means the page becomes wider
// than the viewport (horizontal scroll already works via this file's
// other Phase 9A change to .reader-canvas-wrap). See
// getDominantFontSizePt()'s own comment for why this reads the PDF's
// real, embedded font size instead of guessing at page layout.
const MIN_READABLE_FONT_PX = 15;

// Phase 9C.4 — EPUB is untrusted content (a ZIP of arbitrary HTML/CSS,
// even when it came from our own generation pipeline): scripts and
// popups must stay disabled forever (allowScriptedContent/allowPopups
// are NEVER set below), and this reader — not the EPUB — owns the
// security policy for everything else. Injected via epub.js's public
// `spine.hooks.serialize` because it fires on each chapter's already-
// serialized HTML string before epub.js ever assigns it to an iframe's
// `srcdoc`, i.e. before the browser gets a chance to load a single
// external resource (see the Phase 9C.1-9C.3 spikes for the evidence
// behind every directive here). Any author-supplied CSP is stripped,
// not trusted, so this policy is always the one actually enforced.
const EPUB_READER_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data: blob:; media-src 'self' data: blob:; script-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

// Phase 9C.5 — epub.js's own themes API (never hand-rewriting chapter
// DOM); index 1 (100%) is the default. Locations count is epub.js's
// own commonly-used granularity for percentageFromCfi() - proven at
// this value across every Phase 9C.1-9C.4 test against the real book.
const EPUB_FONT_SIZE_STEPS = [90, 100, 110, 120, 130, 140, 150];
const EPUB_DEFAULT_FONT_INDEX = 1;
const EPUB_LOCATIONS_COUNT = 1000;

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
  const tocTriggerBtn = document.querySelector('[data-reader-toc-trigger]');
  const tocPanel = document.querySelector('[data-reader-toc-panel]');
  const tocCloseBtn = document.querySelector('[data-reader-toc-close]');
  const tocListEl = document.querySelector('[data-reader-toc-list]');
  const searchTriggerBtn = document.querySelector('[data-reader-search-trigger]');
  const searchPanel = document.querySelector('[data-reader-search-panel]');
  const searchCloseBtn = document.querySelector('[data-reader-search-close]');
  const searchFormEl = document.querySelector('[data-reader-search-form]');
  const searchInputEl = document.querySelector('[data-reader-search-input]');
  const searchStatusEl = document.querySelector('[data-reader-search-status]');
  const searchResultsEl = document.querySelector('[data-reader-search-results]');
  const drawerBackdropEl = document.querySelector('[data-reader-drawer-backdrop]');
  const bookmarkAddBtn = document.querySelector('[data-reader-bookmark-add]');
  const bookmarksTriggerBtn = document.querySelector('[data-reader-bookmarks-trigger]');
  const bookmarksPanel = document.querySelector('[data-reader-bookmarks-panel]');
  const bookmarksCloseBtn = document.querySelector('[data-reader-bookmarks-close]');
  const bookmarksListEl = document.querySelector('[data-reader-bookmarks-list]');
  const bookmarksEmptyEl = document.querySelector('[data-reader-bookmarks-empty]');

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

  // Phase 9C.5 — EPUB reader state, kept separate from the PDF state
  // above rather than interleaved with it (the two formats are
  // mutually exclusive per page load - only one of these two state
  // groups is ever actually used).
  let epubBook = null;
  let epubRendition = null;
  let epubFontIndex = EPUB_DEFAULT_FONT_INDEX;
  let epubLocationsGenerated = false;
  let epubSearching = false;
  let epubCfiSaveTimer = null;

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

    if (asset.fileType === 'EPUB') {
      // Phase 9C.4 — minimal, CSP-hardened EPUB initialization; see
      // openEpubReadSession()'s own header comment for exactly what
      // this does and, just as importantly, does not do yet.
      shellEl.hidden = false;
      await openEpubReadSession(reference, asset);
      return;
    }

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

  /**
   * Phase 9C.4 — strips any author-supplied CSP (never trusted - see
   * this file's EPUB_READER_CSP comment) and inserts the reader's own,
   * tolerating a `<head>` with attributes (e.g. `<head lang="en">`)
   * and mismatched case, without disturbing the rest of the chapter's
   * markup. Registered on `book.spine.hooks.serialize`, which epub.js
   * itself already uses internally for its own blob-URL resource
   * substitution (confirmed via source inspection) - reading
   * `section.output` here, not the possibly-stale `output` argument,
   * is what makes this compose correctly with that internal hook
   * regardless of which one runs first.
   */
  function injectReaderCsp(output, section) {
    let html = section.output;
    html = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');
    const cspTag = `<meta http-equiv="Content-Security-Policy" content="${EPUB_READER_CSP}">`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, (match, attrs) => `<head${attrs}>${cspTag}`);
    } else {
      html = html.replace(/<html[^>]*>/i, (match) => `${match}<head>${cspTag}</head>`);
    }
    section.output = html;
  }

  /** Phase 9C.4 — the vendored bundle is a classic UMD script (window.ePub), not an ES module PDF.js's own import can sit next to; loaded on demand, once, only when an EPUB is actually opened. */
  let epubJsLoading = null;
  function loadEpubJsLibrary() {
    if (window.ePub) return Promise.resolve();
    if (epubJsLoading) return epubJsLoading;
    epubJsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/vendor/epubjs/epub.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load the EPUB reader library.'));
      document.head.appendChild(script);
    });
    return epubJsLoading;
  }

  /**
   * Phase 9C.5 — the actual EPUB reading experience, built on the
   * Phase 9C.4 CSP-hardened foundation: chapter navigation, TOC,
   * search, font size, and resume. Reuses the exact same read-access
   * token/Blob pipeline openReadSession() (above) already uses for
   * PDF - entitlement/access control is untouched here, only the
   * format differs. AI citations and annotations are explicitly not
   * part of this phase.
   */
  async function openEpubReadSession(reference, asset) {
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

    let arrayBuffer;
    try {
      const response = await fetch(readUrl);
      if (!response.ok) throw new Error('bad response');
      arrayBuffer = await response.arrayBuffer();
    } catch {
      showError('This resource could not be opened right now. Please try again, or use My Library.');
      return;
    }

    try {
      await loadEpubJsLibrary();
    } catch (error) {
      showError(error.message);
      return;
    }

    canvas.style.display = 'none'; // this render target is PDF.js's canvas - EPUB renders into an epub.js-managed iframe alongside it instead
    // Phase 9C.10 — real, confirmed bug (not a `min-height` fix, which
    // was already here and did NOT work): epub.js's `renderTo(el,
    // {height: '100%'})` needs its *host* element to already have a
    // DEFINITE height for that percentage to resolve against. With the
    // PDF <canvas> hidden, `.reader-canvas-wrap` had nothing else to
    // size itself from - `height: auto` plus a child needing
    // `height: 100%` is a circular dependency CSS resolves to 0, not
    // to `min-height`'s value (`min-height` only floors an
    // already-definite height; it does not make an auto height
    // definite). `.reader-canvas-wrap--epub` (css/components.css)
    // gives the wrap a real `height` instead. Confirmed directly: the
    // iframe epub.js created was always present with the real chapter
    // text already inside it - this was never a fetch/CSP/entitlement
    // problem, purely a layout one.
    canvasWrap.classList.add('reader-canvas-wrap--epub');
    pageIndicatorEl.textContent = 'Reading…';
    const loadingNotice = document.createElement('p');
    loadingNotice.className = 'text-secondary';
    loadingNotice.textContent = 'Loading your book…';
    loadingNotice.setAttribute('data-reader-epub-loading', '');
    canvasWrap.appendChild(loadingNotice);
    const removeLoadingNotice = () => {
      const el = canvasWrap.querySelector('[data-reader-epub-loading]');
      if (el) el.remove();
    };

    try {
      epubBook = window.ePub(arrayBuffer);
      await epubBook.ready;
    } catch {
      removeLoadingNotice();
      showError('This file could not be displayed. Please try again, or download it instead from My Library.');
      return;
    }

    // Registered before renderTo()/display() ever runs, so every
    // section - including the very first one shown - gets the
    // reader's CSP before its content is ever parsed.
    epubBook.spine.hooks.serialize.register(injectReaderCsp);
    // Deliberately the default (paginated) flow, not 'scrolled-doc':
    // confirmed directly that 'scrolled-doc' never resolves display()
    // in this reader's actual layout (reproduced in complete isolation,
    // outside this file entirely, so it isn't specific to anything
    // here) - paginated flow also matches the existing Previous/Next
    // buttons' own semantics more naturally than a continuous scroll
    // would anyway.
    epubRendition = epubBook.renderTo(canvasWrap, { width: '100%', height: '100%' });
    epubRendition.on('relocated', handleEpubRelocated);
    epubRendition.on('rendered', cleanupDuplicateEpubContainers);

    wireEpubControls();
    wireEpubDrawers();

    epubBook.loaded.navigation
      .then((nav) => {
        tocListEl.innerHTML = '';
        renderTocItems(nav.toc, tocListEl);
      })
      .catch(() => {
        // non-fatal - TOC just stays empty; chapter prev/next still works
      });

    const savedCfi = await loadEpubProgress(reference, asset.assetId);
    try {
      if (savedCfi) {
        await epubRendition.display(savedCfi);
        resumeBannerTextEl.textContent = 'Resumed from where you left off.';
        resumeBannerEl.hidden = false;
        if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-shown', currentProductSlug);
        resumeRestartBtn.addEventListener('click', () => {
          resumeBannerEl.hidden = true;
          if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-restarted', currentProductSlug);
          epubRendition.display();
        });
      } else {
        await epubRendition.display();
      }
    } catch {
      // Phase 9C.5 — an invalid/stale saved CFI (e.g. the file changed
      // since it was saved) must never crash the reader; fall back to
      // the beginning exactly like a first-time open, and clear the
      // now-untrustworthy saved position rather than trying it again
      // next time.
      clearEpubProgress(asset.assetId);
      try {
        await epubRendition.display();
      } catch {
        removeLoadingNotice();
        showError('This file could not be displayed. Please try again, or download it instead from My Library.');
        return;
      }
    }

    removeLoadingNotice();
    ensureEpubLocationsGenerated();
  }

  function wireEpubControls() {
    prevBtn.addEventListener('click', () => epubRendition.prev());
    nextBtn.addEventListener('click', () => epubRendition.next());
    zoomOutBtn.setAttribute('aria-label', 'Decrease font size');
    zoomInBtn.setAttribute('aria-label', 'Increase font size');
    zoomOutBtn.addEventListener('click', () => setEpubFontSize(epubFontIndex - 1));
    zoomInBtn.addEventListener('click', () => setEpubFontSize(epubFontIndex + 1));
    tocTriggerBtn.hidden = false;
    searchTriggerBtn.hidden = false;

    canvasWrap.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') epubRendition.next();
      if (event.key === 'ArrowLeft') epubRendition.prev();
    });

    // Mirrors flushProgressOnUnload()'s own reasoning above: the
    // debounced save from the most recent relocation may not have
    // fired yet by the time the customer navigates away.
    window.addEventListener('pagehide', flushEpubProgressOnUnload);

    wireBookmarkControls(
      () => {
        const loc = epubRendition && epubRendition.currentLocation();
        const cfi = loc && loc.start && loc.start.cfi;
        if (!cfi) return null;
        // A real, currently-highlighted TOC entry's own text - never a
        // fabricated label; null (rendered as "Saved position" by
        // loadBookmarksList()) when no TOC entry is active yet.
        const activeLink = tocListEl.querySelector('.reader-toc__link--active');
        return { format: 'EPUB', cfi, label: activeLink ? activeLink.textContent.trim() : null };
      },
      (bookmark) => {
        if (bookmark.cfi) epubRendition.display(bookmark.cfi).catch(() => {});
      }
    );
  }

  function wireEpubDrawers() {
    tocTriggerBtn.addEventListener('click', () => openReaderDrawer(tocPanel));
    tocCloseBtn.addEventListener('click', closeReaderDrawers);
    searchTriggerBtn.addEventListener('click', () => openReaderDrawer(searchPanel));
    searchCloseBtn.addEventListener('click', closeReaderDrawers);
    drawerBackdropEl.addEventListener('click', closeReaderDrawers);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && (!tocPanel.hidden || !searchPanel.hidden)) closeReaderDrawers();
    });
    searchFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      runEpubSearch(searchInputEl.value);
    });
  }

  /** Phase 9C.5 — TOC and search share one drawer treatment (see css/components.css's .reader-drawer); only one is ever open at a time. */
  function openReaderDrawer(panel) {
    closeReaderDrawers();
    panel.hidden = false;
    drawerBackdropEl.hidden = false;
    requestAnimationFrame(() => {
      panel.classList.add('reader-drawer--open');
      drawerBackdropEl.classList.add('reader-drawer-backdrop--visible');
    });
  }
  function closeReaderDrawers() {
    tocPanel.classList.remove('reader-drawer--open');
    searchPanel.classList.remove('reader-drawer--open');
    bookmarksPanel.classList.remove('reader-drawer--open');
    drawerBackdropEl.classList.remove('reader-drawer-backdrop--visible');
    setTimeout(() => {
      tocPanel.hidden = true;
      searchPanel.hidden = true;
      bookmarksPanel.hidden = true;
      drawerBackdropEl.hidden = true;
    }, 220);
  }

  /**
   * Digital Library 2.0 (Bookmarks) — the one piece of reader chrome
   * genuinely shared, unmodified, between the PDF and EPUB paths (a
   * bookmark is just "a position + an optional real label"; only how
   * that position is read/navigated-to differs). `getPosition` returns
   * the current {format, pageNumber} or {format, cfi} plus a real,
   * non-fabricated label (PDF: "Page N"; EPUB: the currently-highlighted
   * TOC entry's own text, or null when none is active — never invented).
   * `goTo(bookmark)` performs the actual jump for whichever format is
   * live. Called once from each of wireControls() (PDF) and
   * wireEpubControls() (EPUB), never both in the same page load.
   */
  function wireBookmarkControls(getPosition, goTo) {
    bookmarkAddBtn.hidden = false;
    bookmarksTriggerBtn.hidden = false;

    bookmarkAddBtn.addEventListener('click', async () => {
      const position = getPosition();
      if (!position) return;
      bookmarkAddBtn.disabled = true;
      try {
        await window.CustomerDashboard.customerFetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/bookmarks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: currentAssetId, ...position }),
        });
        const original = bookmarkAddBtn.textContent;
        bookmarkAddBtn.textContent = '✓';
        setTimeout(() => {
          bookmarkAddBtn.textContent = original;
        }, 1200);
        if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-bookmark-added', currentProductSlug);
      } catch {
        // Silent by design, matching writeProgress()'s own header comment - a failed save must never interrupt reading.
      } finally {
        bookmarkAddBtn.disabled = false;
      }
    });

    bookmarksTriggerBtn.addEventListener('click', () => {
      openReaderDrawer(bookmarksPanel);
      loadBookmarksList(goTo);
    });
    bookmarksCloseBtn.addEventListener('click', closeReaderDrawers);
  }

  async function loadBookmarksList(goTo) {
    bookmarksListEl.innerHTML = '';
    bookmarksEmptyEl.hidden = true;
    let bookmarks = [];
    try {
      const result = await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(currentReference)}/bookmarks?assetId=${encodeURIComponent(currentAssetId)}`
      );
      bookmarks = result.bookmarks || [];
    } catch {
      // Non-fatal — the panel just shows the empty state, same as genuinely having none.
    }

    if (bookmarks.length === 0) {
      bookmarksEmptyEl.hidden = false;
      return;
    }

    bookmarks.forEach((bookmark) => {
      const row = document.createElement('div');
      row.className = 'reader-bookmark-item';

      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'reader-bookmark-item__go';
      const labelEl = document.createElement('span');
      labelEl.className = 'reader-bookmark-item__label';
      labelEl.textContent = bookmark.label || (bookmark.format === 'PDF' ? `Page ${bookmark.pageNumber}` : 'Saved position');
      const metaEl = document.createElement('span');
      metaEl.className = 'reader-bookmark-item__meta';
      const savedDate = new Date(bookmark.createdAt);
      metaEl.textContent = Number.isNaN(savedDate.getTime()) ? '' : `Saved ${savedDate.toLocaleDateString()}`;
      goBtn.appendChild(labelEl);
      goBtn.appendChild(metaEl);
      goBtn.addEventListener('click', () => {
        closeReaderDrawers();
        goTo(bookmark);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'reader-bookmark-item__delete';
      deleteBtn.setAttribute('aria-label', 'Remove this bookmark');
      deleteBtn.textContent = '×';
      deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        try {
          await window.CustomerDashboard.customerFetch(`/api/customer/bookmarks/${encodeURIComponent(bookmark.id)}`, { method: 'DELETE' });
          row.remove();
          if (!bookmarksListEl.children.length) bookmarksEmptyEl.hidden = false;
        } catch {
          deleteBtn.disabled = false;
        }
      });

      row.appendChild(goBtn);
      row.appendChild(deleteBtn);
      bookmarksListEl.appendChild(row);
    });
  }

  /**
   * Phase 9C.5 — a parent-only heading (a <span>, not an <a>, in this
   * project's own real book's nav.xhtml - confirmed real, not
   * hypothetical, in the Phase 9C.1 spike) has no href to navigate
   * to. Rendered as inert heading text; only entries epub.js's own
   * navigation actually resolved a real href for become clickable, so
   * `rendition.display()` is never called with a fabricated target.
   */
  function renderTocItems(items, container) {
    const list = document.createElement('ul');
    list.className = container === tocListEl ? 'reader-toc__list' : 'reader-toc__sublist';
    items.forEach((item) => {
      const li = document.createElement('li');
      if (item.href) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'reader-toc__link';
        link.dataset.href = item.href;
        link.textContent = item.label.trim();
        link.addEventListener('click', () => {
          closeReaderDrawers();
          epubRendition.display(item.href).catch(() => {
            // non-fatal - stay on the current chapter rather than breaking the whole reader
          });
        });
        li.appendChild(link);
      } else {
        const heading = document.createElement('span');
        heading.className = 'reader-toc__heading';
        heading.textContent = item.label.trim();
        li.appendChild(heading);
      }
      if (item.subitems && item.subitems.length) renderTocItems(item.subitems, li);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  function highlightActiveTocEntry(href) {
    tocListEl.querySelectorAll('.reader-toc__link').forEach((link) => {
      link.classList.toggle('reader-toc__link--active', link.dataset.href === href);
    });
  }

  /**
   * Phase 9C.10 — real, confirmed bug: this vendored epub.js build can
   * end up with TWO `.epub-container` elements inside the same host
   * (`canvasWrap`) after `renderTo()`/`display()` — one genuinely
   * empty-looking (its iframe present, its chapter text already
   * loaded into `contentDocument`, but collapsed to `height: 0`
   * because it was laid out before `.reader-canvas-wrap--epub` gave
   * the host a definite height) and, appended after it, a second one
   * that IS correctly sized and is the one `epubRendition.manager`
   * itself actually tracks going forward. `canvasWrap.querySelector('iframe')`-
   * style DOM lookups (and a real visitor's eyes) find the first,
   * stale one - reproduced directly, isolated from every other part
   * of this file, by inspecting `.epub-container` elements one at a
   * time. Removing every `.epub-container` except the manager's own
   * current `stage.container` is a defensive cleanup that works
   * regardless of why the extra one appears (a future epub.js update
   * that stops duplicating it makes this a no-op, not a break) -
   * called after every render, not just the first, since chapter
   * navigation can in principle hit the same path again.
   */
  function cleanupDuplicateEpubContainers() {
    if (!epubRendition || !epubRendition.manager || !epubRendition.manager.stage) return;
    const activeContainer = epubRendition.manager.stage.container;
    canvasWrap.querySelectorAll('.epub-container').forEach((el) => {
      if (el !== activeContainer) el.remove();
    });
  }

  /** Phase 9C.5 — fires on every chapter/page change; drives the progress indicator, TOC highlight, and debounced resume save all from the one epub.js event, rather than polling. */
  function handleEpubRelocated(location) {
    const cfi = location && location.start && location.start.cfi;
    if (!cfi) return;
    if (epubLocationsGenerated) {
      const pct = epubBook.locations.percentageFromCfi(cfi);
      if (typeof pct === 'number' && !Number.isNaN(pct)) {
        const roundedPct = Math.round(pct * 100);
        pageIndicatorEl.textContent = `${roundedPct}%`;
        progressFillEl.style.width = `${roundedPct}%`;
      }
    } else {
      pageIndicatorEl.textContent = 'Reading…';
    }
    if (location.start.href) highlightActiveTocEntry(location.start.href);
    scheduleEpubProgressSave(cfi);
  }

  /** Phase 9C.5 — generated once per session, not on every relocation (a full-book scan is real work); re-derives the percentage for the current position once it's ready, since the first few relocations before this resolves can only show "Reading…". */
  function ensureEpubLocationsGenerated() {
    if (epubLocationsGenerated || !epubBook) return;
    epubBook.locations
      .generate(EPUB_LOCATIONS_COUNT)
      .then(() => {
        epubLocationsGenerated = true;
        const loc = epubRendition.currentLocation();
        if (loc && loc.start && loc.start.cfi) handleEpubRelocated(loc);
      })
      .catch(() => {
        // non-fatal - percentage just won't display; CFI-based resume is unaffected
      });
  }

  function setEpubFontSize(index) {
    epubFontIndex = Math.min(EPUB_FONT_SIZE_STEPS.length - 1, Math.max(0, index));
    epubRendition.themes.fontSize(`${EPUB_FONT_SIZE_STEPS[epubFontIndex]}%`);
  }

  /**
   * Digital Library 2.0 — real, server-persisted EPUB progress,
   * closing the gap Phase 9C.5 deliberately deferred (resume did not
   * survive a different device/browser the way PDF's already did).
   * Reuses the exact same /api/customer/purchases/:reference/progress
   * endpoint PDF writes to (backend/services/customer/
   * libraryProgressService.ts now accepts either {currentPage,
   * totalPages} or {cfi, percentComplete}, never both) - not a second,
   * parallel progress system. localStorage remains as an instant,
   * offline-friendly cache (read first, before the network reply can
   * arrive) but the server value is authoritative once it does,
   * matching PDF's own posture exactly.
   */
  function epubProgressKey(assetId) {
    return `robayer_epub_progress_${assetId}`;
  }
  /** Mirrors handleEpubRelocated()'s own percentage computation - 0 before locations finish generating, never a fabricated value. */
  function computeEpubPercent(cfi) {
    if (!epubLocationsGenerated || !epubBook) return 0;
    const pct = epubBook.locations.percentageFromCfi(cfi);
    return typeof pct === 'number' && !Number.isNaN(pct) ? Math.round(pct * 100) : 0;
  }
  function scheduleEpubProgressSave(cfi) {
    if (epubCfiSaveTimer) clearTimeout(epubCfiSaveTimer);
    epubCfiSaveTimer = setTimeout(() => saveEpubProgress(cfi), PROGRESS_WRITE_DEBOUNCE_MS);
  }
  /** A failed write (local or server) is swallowed on purpose - see writeProgress()'s own header comment; reading must never stop, error, or hesitate because a progress save didn't go through. */
  async function saveEpubProgress(cfi) {
    try {
      localStorage.setItem(epubProgressKey(currentAssetId), JSON.stringify({ cfi, updatedAt: Date.now() }));
    } catch {
      // non-fatal
    }
    try {
      await window.CustomerDashboard.customerFetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: currentAssetId, cfi, percentComplete: computeEpubPercent(cfi) }),
      });
    } catch {
      // non-fatal
    }
  }
  /**
   * Guarantees the LATEST CFI is saved even if the debounce timer from
   * the most recent relocation hasn't fired yet when the customer
   * navigates away - the exact same reasoning as flushProgressOnUnload()
   * (PDF's equivalent), including why this bypasses customerFetch()
   * for a manual `keepalive` request instead of calling the async
   * saveEpubProgress() above (which customerFetch() itself cannot
   * outlive a navigating-away page for).
   */
  function flushEpubProgressOnUnload() {
    if (!epubRendition) return;
    if (epubCfiSaveTimer) clearTimeout(epubCfiSaveTimer);
    const loc = epubRendition.currentLocation();
    const cfi = loc && loc.start && loc.start.cfi;
    if (!cfi) return;
    try {
      localStorage.setItem(epubProgressKey(currentAssetId), JSON.stringify({ cfi, updatedAt: Date.now() }));
    } catch {
      // non-fatal
    }
    const csrf = window.CustomerDashboard.getCsrfToken();
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Customer-CSRF-Token'] = csrf;
    fetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ assetId: currentAssetId, cfi, percentComplete: computeEpubPercent(cfi) }),
      keepalive: true,
    }).catch(() => {});
  }
  /** Server progress wins when present (the real, cross-device source of truth); the local cache is a fallback for an offline/failed request, not a competing source - matches "server-derived, never trusted verbatim from a second source" elsewhere in this file. */
  async function loadEpubProgress(reference, assetId) {
    try {
      const result = await window.CustomerDashboard.customerFetch(
        `/api/customer/purchases/${encodeURIComponent(reference)}/progress?assetId=${encodeURIComponent(assetId)}`
      );
      if (result.progress && result.progress.format === 'EPUB' && result.progress.cfi) return result.progress.cfi;
    } catch {
      // fall through to the local cache below
    }
    try {
      const raw = localStorage.getItem(epubProgressKey(assetId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed.cfi === 'string' ? parsed.cfi : null;
    } catch {
      return null;
    }
  }
  function clearEpubProgress(assetId) {
    try {
      localStorage.removeItem(epubProgressKey(assetId));
    } catch {
      // non-fatal
    }
  }

  /** Phase 9C.5 — one full-book scan per search submission (not per keystroke - there is no live-search here, so no separate debounce is needed), reusing epub.js's own Section.find(); never exposes iframe DOM to the parent beyond the {cfi, excerpt} pairs epub.js itself returns. */
  async function runEpubSearch(query) {
    const trimmed = query.trim();
    if (epubSearching || !trimmed || !epubBook) return;
    epubSearching = true;
    searchStatusEl.textContent = 'Searching…';
    searchResultsEl.innerHTML = '';
    const results = [];
    try {
      for (const item of epubBook.spine.spineItems) {
        await item.load(epubBook.load.bind(epubBook));
        const matches = item.find(trimmed);
        matches.forEach((match) => results.push(match));
        item.unload();
      }
    } catch {
      // non-fatal - render whatever was found before the failure
    }
    epubSearching = false;
    renderEpubSearchResults(results, trimmed);
  }

  function renderEpubSearchResults(results, query) {
    searchResultsEl.innerHTML = '';
    if (!results.length) {
      searchStatusEl.textContent = `No matches for "${query}".`;
      return;
    }
    searchStatusEl.textContent = `${results.length} match${results.length === 1 ? '' : 'es'} found.`;
    results.forEach((result) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reader-search-result';
      btn.textContent = result.excerpt;
      btn.addEventListener('click', () => {
        closeReaderDrawers();
        epubRendition.display(result.cfi).catch(() => {
          // non-fatal - stay on the current chapter rather than breaking the whole reader
        });
      });
      searchResultsEl.appendChild(btn);
    });
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

    wireBookmarkControls(
      () => ({ format: 'PDF', pageNumber: currentPage, label: `Page ${currentPage}` }),
      (bookmark) => goToPage(bookmark.pageNumber)
    );
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
   * Phase 9A follow-up — the page's real, embedded body-text size,
   * read from PDF.js's own text-content metadata rather than guessed
   * from layout. Deliberately NOT content-bounding-box detection or
   * any kind of margin-cropping heuristic: those vary page-to-page
   * (a title page, a page with a pull-quote, a mostly-blank chapter
   * opener) and would make the page jump between different effective
   * zoom levels as a customer turns pages, exactly the "unreliable
   * across books" failure mode worth avoiding - see this file's
   * accompanying investigation notes. Font size is different: it's
   * data the PDF already states outright for every run of text, not
   * something inferred, and a book's body font is consistent enough
   * page-to-page (confirmed directly against two different real
   * Library books - a 40-page and a 12-page title, both single-column
   * body text) that reading it from whichever page establishes the
   * default scale (page 1, or a resumed page) is representative for
   * the rest of that reading session.
   *
   * Char-count-weighted, not occurrence-weighted: a title page has few
   * long-run title characters and often more small-print (footer/
   * disclaimer) characters, so weighting by how much text is actually
   * set in each size - not how many separate text runs use it - is
   * what makes this resolve to the real body size even on a cover
   * (confirmed directly: Treasury Bills Made Simple's own cover page
   * resolves to its 12pt body size, not its larger title size).
   *
   * Non-fatal by design: a page with no extractable text (a scanned
   * image, for instance) simply returns null and the caller falls back
   * to plain fit-to-width, same as this file's other silent-fallback
   * patterns.
   */
  async function getDominantFontSizePt(page) {
    try {
      const content = await page.getTextContent();
      const charsBySize = new Map();
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const size = Math.abs(item.transform[3]);
        if (!size) continue;
        charsBySize.set(size, (charsBySize.get(size) || 0) + item.str.length);
      }
      let bestSize = null;
      let bestCount = -1;
      for (const [size, count] of charsBySize) {
        if (count > bestCount) {
          bestCount = count;
          bestSize = size;
        }
      }
      return bestSize;
    } catch {
      return null;
    }
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
   *
   * Phase 9A follow-up — fit-to-width alone is then raised further, if
   * needed, so the page's own real body font (see
   * getDominantFontSizePt() above) renders at least MIN_READABLE_FONT_PX
   * tall - a real gap found after shipping fit-to-width: on a phone,
   * fitting a full Letter/A4-width document page legibly requires more
   * zoom than "the whole page fits with no horizontal scroll" allows.
   * When the two goals conflict, legibility wins and the page becomes
   * horizontally scrollable instead - the existing overflow/pan support
   * this file already has, not new behavior.
   */
  async function computeFitScale(page, unscaledWidth) {
    const fit = Math.min(MAX_SCALE, getWrapContentWidth() / unscaledWidth);
    const dominantFontPt = await getDominantFontSizePt(page);
    let final = fit;
    if (dominantFontPt) {
      const minLegibleScale = MIN_READABLE_FONT_PX / dominantFontPt;
      final = Math.min(MAX_SCALE, Math.max(fit, minLegibleScale));
    }
    lastFitScale = final;
    return final;
  }

  /** Phase 9A — resize/orientation-change handler: recomputes the fit-to-width scale for the new available width and re-renders at it, same calculation as the initial load. */
  async function refitAndRerender() {
    if (!pdfDoc || rendering) return;
    const page = await pdfDoc.getPage(currentPage);
    scale = await computeFitScale(page, page.getViewport({ scale: 1 }).width);
    renderPage(currentPage);
  }

  async function renderPage(pageNumber) {
    rendering = true;
    prevBtn.disabled = pageNumber <= 1;
    nextBtn.disabled = pageNumber >= pdfDoc.numPages;

    const page = await pdfDoc.getPage(pageNumber);
    if (scale === null) scale = await computeFitScale(page, page.getViewport({ scale: 1 }).width);

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
