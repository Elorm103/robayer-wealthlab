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
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' blob: 'unsafe-inline'; " +
  "font-src 'self' data: blob:; media-src 'self' data: blob:; script-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

// Phase 9C.5 — epub.js's own themes API (never hand-rewriting chapter
// DOM); index 1 (100%) is the default. Locations count is epub.js's
// own commonly-used granularity for percentageFromCfi() - proven at
// this value across every Phase 9C.1-9C.4 test against the real book.
const EPUB_FONT_SIZE_STEPS = [90, 100, 110, 120, 130, 140, 150];
const EPUB_DEFAULT_FONT_INDEX = 1;
const EPUB_LOCATIONS_COUNT = 1000;

// White-flash/readability fix — confirmed directly against the real
// "Understanding the Ghana Stock Exchange" EPUB: its own style/main.css
// sets font-family/line-height and a handful of heading colors, but
// never an explicit background-color or body text color. Without an
// explicit one from this reader, a chapter's <html>/<body> render
// browser-default black text over whatever background happens to show
// through - live-confirmed to be nearly unreadable (near-black-on-
// near-black) against a dark reading surface, and jarring (default
// opaque white, the real source of the reported "bright/white EPUB
// page" - an <iframe> is opaque white by default regardless of its own
// content unless something says otherwise, and nothing here ever did)
// wherever that transparency chain doesn't resolve to something dark.
// Two named epub.js themes (see applyEpubReadingTheme() below), so the
// reading surface always matches the reader shell around it and
// switches live with the site's own dark-mode toggle. `!important` is
// deliberately scoped to ONLY html/body background-color and color -
// this sets the page's baseline/inherited default, never a book
// element's own explicit styling (a class-based heading color, a
// callout box's own background, etc.), which only competes for the
// SAME property on the SAME element it targets and so is completely
// unaffected by an !important rule on a different element (see this
// file's own header comment on EPUB_READING_THEMES for the fuller
// reasoning). Literal hex values, not var() references, because CSS
// custom properties don't cross into an epub.js iframe's own isolated
// document - these are the exact values of this site's own
// --color-bg-alt/--color-text-primary/--color-accent tokens
// (tokens.css), kept in sync with that file, not a separate palette.
const EPUB_READING_THEMES = {
  light: {
    'html, body': { 'background-color': '#FAF6EF !important', color: '#22252B !important' },
    a: { color: '#206F34 !important' },
  },
  dark: {
    'html, body': { 'background-color': '#1B222D !important', color: '#E4E1D8 !important' },
    a: { color: '#53C679 !important' },
  },
};

function initLibraryReader() {
  const root = document.querySelector('[data-reader-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-reader-loading]');
  const errorEl = document.querySelector('[data-reader-error]');
  const titleEl = document.querySelector('[data-reader-title]');
  const topicEl = document.querySelector('[data-reader-topic]');
  const formatSwitchEl = document.querySelector('[data-reader-format-switch]');
  const reviewLinkEl = document.querySelector('[data-reader-review-link]');
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
  const moreMenuTriggerBtn = document.querySelector('[data-reader-more-trigger]');
  const moreMenuPanel = document.querySelector('[data-reader-more-panel]');
  const epubRenderErrorEl = document.querySelector('[data-reader-epub-render-error]');
  const epubRenderRetryBtn = document.querySelector('[data-reader-epub-retry]');

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
  /** Drawer auto-close fix — see closeReaderDrawers()'s own comment for the bug this cancels. Shared by both formats (TOC/search are EPUB-only, but the bookmarks drawer is not — see wireBookmarkControls()'s own comment). */
  let drawerHideTimer = null;

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
  /**
   * Blank-canvas root-cause fix — confirmed directly by reading the
   * vendored epub.js source (js/vendor/epubjs/epub.min.js), not
   * assumed: Rendition.next()/prev()/display() already share ONE
   * internal queue inside epub.js itself (Rendition.q), but
   * Rendition.resize() bypasses that queue entirely and calls the view
   * manager directly. Worse, epub.js's own DefaultViewManager ALSO
   * installs its own automatic, internally-debounced (50ms)
   * `window.resize` listener whenever the rendition isn't given fixed
   * numeric width/height — which is exactly this reader's own
   * configuration (`renderTo(canvasWrap, {width:'100%', height:'100%'})`,
   * see openEpubReadSession() below). The earlier "mobile reader fix"
   * phase added a SECOND, independently-debounced (150ms) manual
   * `window.resize` listener on top of that already-automatic one —
   * two uncoordinated resize-triggered clear()+relayout cycles firing
   * off the same physical resize event, each capable of clearing the
   * view the other was mid-render into. That duplicate listener is
   * removed below (see wireEpubControls()'s own comment); this queue is
   * this file's OWN external serialization, layered on top of epub.js's
   * internal one, so every resize()/display()/next()/prev() THIS FILE
   * initiates can never overlap each other either.
   */
  let epubOperationChain = Promise.resolve();
  /** The most recent CFI a real, successful relocation confirmed — used both to restore position after a resize (passed as resize()'s own third argument, its native redisplay-target parameter) and as the Retry button's target after a genuine render failure. Never epubRendition.currentLocation() directly, which can be stale/unset mid-failure. */
  let lastKnownGoodCfi = null;
  /** Digital Library 2.0 Phase H — the last spine href a 'library-reader:section-changed' event was dispatched for, so relocations WITHIN a chapter (scrolling/paging, which epub.js also reports via 'relocated') don't re-fire it. */
  let lastDispatchedEpubHref = null;

  document.addEventListener('dashboard:ready', load, { once: true });

  /** See load()'s own comment on why this is a top-level function rather than nested inside load() - every EPUB entry point (legacy and controlled) needs to call this once, after its own controlled-vs-legacy decision is known, not before. */
  function dispatchReaderReady(reference, assetId, productSlug, bookTitle, supportsAi) {
    document.dispatchEvent(
      new CustomEvent('library-reader:ready', {
        detail: { purchaseReference: reference, assetId, productSlug, bookTitle, supportsAi },
      })
    );
  }

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    // Digital Library Phase F — an optional deep-link target for a
    // specific bookmark, set only when arriving from the Library-wide
    // Bookmarks view (a bookmark can belong to a book that isn't
    // currently open, so a plain in-page goTo() there doesn't apply).
    // Absent for every existing link shape (Library card, Continue
    // Reading, resume banner), which all still just open to the
    // customer's real saved progress exactly as before.
    return { reference: params.get('ref'), assetId: params.get('assetId'), jumpPage: params.get('page'), jumpCfi: params.get('cfi') };
  }

  /**
   * Phase 4 (production-readiness pass, Section C) — closes two real
   * gaps found while reviewing the reader's own controls: (1) a
   * customer who owns both PDF and EPUB for this book had to leave the
   * reader entirely to switch formats (the only "Read PDF"/"Read EPUB"
   * links lived on the My Library card, each pointing at a different
   * reader URL); (2) finishing a book here had no path to reviewing it
   * without navigating away to the book's own public page. Both are
   * pure navigation/presentation - no entitlement, download, purchase,
   * or review-writing logic is touched; every link here still goes
   * through this same reader's own existing load()/read-access flow, or
   * to the site's own existing, unmodified review UI.
   */
  async function renderReaderMeta(purchase, asset) {
    const ownedAssets = (purchase.assets || []).filter((a) => !a.revoked);
    if (formatSwitchEl && ownedAssets.length > 1) {
      formatSwitchEl.innerHTML = '';
      ownedAssets.forEach((a) => {
        const label = a.fileType === 'PDF' ? 'Read PDF' : a.fileType === 'EPUB' ? 'Read EPUB' : `Read ${a.displayName || a.fileType}`;
        const isCurrent = a.assetId === asset.assetId;
        const link = document.createElement('a');
        link.className = `btn ${isCurrent ? 'btn--accent' : 'btn--secondary'} reader-header__format-btn`;
        link.textContent = label;
        if (isCurrent) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.href = `/dashboard/read/?ref=${encodeURIComponent(purchase.purchaseReference)}&assetId=${encodeURIComponent(a.assetId)}`;
        }
        formatSwitchEl.appendChild(link);
      });
      formatSwitchEl.hidden = false;
    }

    if (reviewLinkEl) {
      reviewLinkEl.href = `/books/${encodeURIComponent(purchase.productSlug)}/#reviews`;
      reviewLinkEl.hidden = false;
      try {
        const result = await window.CustomerDashboard.customerFetch('/api/customer/reviews');
        const reviewedSlugs = new Set((result.reviews || []).map((r) => r.productSlug));
        reviewLinkEl.textContent = reviewedSlugs.has(purchase.productSlug) ? 'Edit Review' : 'Write a Review';
      } catch {
        // Non-fatal, same as library-list.js's own reviewedSlugs fetch —
        // the link still works, just defaults to the "Write" wording.
      }
    }
  }

  async function load() {
    const { reference, assetId, jumpPage, jumpCfi } = getQueryParams();
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

    renderReaderMeta(purchase, asset);

    // Phase 8 (Digital Library Observability) — fires once the reader
    // has a confirmed, owned book to show, mirroring how the site's own
    // trackProductView() fires once a book-detail page confirms its
    // slug (js/components/analytics.js). Fires for every format,
    // including the honest-unsupported EPUB path below - "opened the
    // reader for this book" is true either way.
    if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-reader-opened', purchase.productSlug);

    // Digital Library Phase 7C (AI Reading Assistant) — the one
    // integration point between the reader and the AI panel
    // (js/components/library-ai-panel.js). Event-based, not a shared
    // module or global mutable state: the panel only ever learns the
    // resource/book title and whether it's a supported format from
    // this one dispatch, and the current page from the page-changed
    // event fired on every render below.
    //
    // Controlled Library Reader - dispatched with the correct supportsAi
    // per actual reading path, not just per file format: PDF's AI
    // support is unaffected by controlled vs. legacy (both report real
    // page numbers), so it dispatches immediately here. EPUB's AI
    // citation-jump relies on real epub.js CFIs the controlled,
    // chapter-scoped reader deliberately does not produce (see
    // openEpubReadSessionControlled()'s own header comment on this
    // disclosed scope reduction) - so for EPUB, dispatchReaderReady()
    // (a top-level function, not nested in load(), so every EPUB entry
    // point below can reach it) is instead called once the
    // controlled-vs-legacy decision is known.
    if (asset.fileType === 'PDF') dispatchReaderReady(reference, assetId, purchase.productSlug, purchase.productTitle, true);

    if (asset.fileType === 'EPUB') {
      // Phase 9C.4 — minimal, CSP-hardened EPUB initialization; see
      // openEpubReadSession()'s own header comment for exactly what
      // this does and, just as importantly, does not do yet.
      shellEl.hidden = false;
      // Controlled Library Reader - tries the protected, chapter-scoped
      // reader session first; falls back to the existing, unmodified
      // whole-file epub.js flow only when the backend explicitly
      // reports the controlled reader is disabled (the documented
      // controlled_reader_enabled rollback path), never on a genuine
      // access denial, which both paths must refuse identically.
      const controlledSession = await mintControlledReaderSession(reference, asset.assetId);
      if (controlledSession.ok) {
        await openEpubReadSessionControlled(reference, asset, controlledSession, jumpCfi);
        return;
      }
      if (!controlledSession.fallback) {
        showError(controlledSession.message);
        return;
      }
      await openEpubReadSession(reference, asset, jumpCfi);
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

    const controlledSession = await mintControlledReaderSession(reference, asset.assetId);
    if (controlledSession.ok) {
      await openReadSessionControlled(reference, asset, savedProgress, jumpPage, controlledSession);
      return;
    }
    if (!controlledSession.fallback) {
      showError(controlledSession.message);
      return;
    }
    await openReadSession(reference, asset, savedProgress, jumpPage);
  }

  /**
   * Controlled Library Reader - mints a protected reader session
   * (POST /api/customer/purchases/:reference/reader-session), the one
   * customer-cookie-authenticated step in the whole controlled-reader flow;
   * every subsequent page/chapter fetch is scoped to the returned
   * session token alone (matching the existing GET /api/download/:token
   * bearer-token pattern). `fallback: true` means specifically "the
   * backend reports controlled_reader_enabled is off" - the ONE case that
   * silently reverts to the pre-existing whole-file flow; any other
   * failure (denied entitlement, revoked delivery, etc.) is a real
   * denial both paths must refuse identically, so it is surfaced as an
   * error, never silently retried against the legacy path.
   */
  async function mintControlledReaderSession(reference, assetId) {
    let deviceFingerprint = null;
    try {
      // Best-effort, non-cryptographic deterrence/concurrency signal
      // only - see readerSessionService.ts's own header comment. Never
      // treated as a security boundary by this file or the backend.
      deviceFingerprint = `${navigator.userAgent}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone || ''}`;
    } catch {
      deviceFingerprint = null;
    }

    try {
      const result = await window.CustomerDashboard.customerFetch(`/api/customer/purchases/${encodeURIComponent(reference)}/reader-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, deviceFingerprint }),
      });
      return { ok: true, token: result.token, fileType: result.fileType, totalPages: result.totalPages, spine: result.spine };
    } catch (error) {
      if (error.code === 'CONTROLLED_READER_DISABLED') {
        return { ok: false, fallback: true };
      }
      return { ok: false, fallback: false, message: error.message || 'This resource could not be opened right now. Please try again.' };
    }
  }

  /**
   * A pdf.js "document"-shaped object satisfying exactly the two
   * members this file's existing, unmodified rendering/navigation code
   * already calls (`.numPages`, `.getPage(n)` - see renderPage(),
   * goToPage(), the resume-banner logic above, flushProgressOnUnload())
   * - but backed by a fresh, single-page, watermarked PDF fetched fresh
   * for EVERY page turn, never the whole book loaded once. This is the
   * actual security boundary: every other function in this file that
   * reads from `pdfDoc` is completely unaware anything changed, by
   * design - "do not unnecessarily rewrite the reader."
   */
  function createControlledPdfDocShim(sessionToken, totalPages) {
    return {
      numPages: totalPages,
      async getPage(pageNumber) {
        const response = await fetch(`/api/reader/${encodeURIComponent(sessionToken)}/page/${pageNumber}`);
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error((body && body.error && body.error.message) || 'This page could not be loaded.');
        }
        const bytes = await response.arrayBuffer();
        const singlePageDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
        return singlePageDoc.getPage(1);
      },
    };
  }

  /** Controlled counterpart to openReadSession() - identical resume/navigation/progress behavior, the only difference is pdfDoc being the per-page shim above instead of the whole file loaded once. */
  async function openReadSessionControlled(reference, asset, savedProgress, jumpPage, controlledSession) {
    pdfDoc = createControlledPdfDocShim(controlledSession.token, controlledSession.totalPages);

    const jumpPageNum = jumpPage ? parseInt(jumpPage, 10) : NaN;
    const validJump = Number.isInteger(jumpPageNum) && jumpPageNum >= 1 && jumpPageNum <= pdfDoc.numPages;
    const canResume =
      !validJump &&
      savedProgress &&
      savedProgress.status !== 'completed' &&
      typeof savedProgress.currentPage === 'number' &&
      savedProgress.currentPage > 1 &&
      savedProgress.currentPage <= pdfDoc.numPages;

    currentPage = validJump ? jumpPageNum : canResume ? savedProgress.currentPage : 1;
    if (canResume && savedProgress.currentPage >= pdfDoc.numPages) completionAlreadyReported = true;
    wireControls();
    window.addEventListener('pagehide', flushProgressOnUnload);

    try {
      await renderPage(currentPage);
    } catch (error) {
      showError(error.message || 'This resource could not be opened right now. Please try again.');
      return;
    }

    if (validJump) {
      resumeBannerTextEl.textContent = `Jumped to your bookmark - page ${jumpPageNum}.`;
      resumeBannerEl.hidden = false;
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        goToPage(1);
      });
    } else if (canResume) {
      resumeBannerTextEl.textContent = `Resumed - page ${savedProgress.currentPage} of ${pdfDoc.numPages}.`;
      resumeBannerEl.hidden = false;
      if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-shown', currentProductSlug);
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        if (window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-restarted', currentProductSlug);
        goToPage(1);
      });
    }
  }

  // ============================================================
  // Controlled Library Reader - EPUB chapter-scoped reader. A
  // deliberately separate, smaller implementation from
  // openEpubReadSession()/epub.js above, not a shim over it: epub.js's
  // own API fundamentally expects the whole book archive up front,
  // which is exactly what this path must never fetch. Scope,
  // disclosed rather than silently reduced: chapter-level navigation
  // (not epub.js's free-scroll/CFI position), a plain spine-order TOC
  // labeled by manifest id (not nav.xhtml/NCX titles), no in-book
  // search. Progress/bookmarks reuse the EXISTING endpoints unchanged,
  // storing a `spine:{href}` marker in the existing `cfi` field as the
  // chapter-granularity position - the legacy epub.js reader (used
  // whenever controlled_reader_enabled is off) is completely unaffected
  // and keeps its full CFI-precise behavior.
  // ============================================================

  let controlledEpubSpine = [];
  let controlledEpubChapterIndex = 0;
  let controlledEpubSessionToken = null;

  function controlledEpubIframe() {
    return canvasWrap.querySelector('[data-controlled-epub-frame]');
  }

  function applyControlledEpubTheme(iframeEl) {
    const doc = iframeEl.contentDocument;
    if (!doc || !doc.documentElement) return;
    const dark = isSiteDarkTheme();
    doc.documentElement.style.setProperty('background-color', dark ? '#1B222D' : '#FAF6EF', 'important');
    doc.documentElement.style.setProperty('color', dark ? '#E4E1D8' : '#22252B', 'important');
    if (doc.body) {
      doc.body.style.setProperty('background-color', dark ? '#1B222D' : '#FAF6EF', 'important');
      doc.body.style.setProperty('color', dark ? '#E4E1D8' : '#22252B', 'important');
    }
  }

  async function renderControlledEpubChapter(index, options) {
    options = options || {};
    if (index < 0 || index >= controlledEpubSpine.length) return;
    controlledEpubChapterIndex = index;
    const href = controlledEpubSpine[index].href;

    canvasWrap.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-controlled-epub-frame', '');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    canvasWrap.appendChild(iframe);

    let response;
    try {
      response = await fetch(`/api/reader/${encodeURIComponent(controlledEpubSessionToken)}/chapter/${encodeURIComponent(href)}`);
    } catch {
      showError('This resource could not be opened right now. Please try again, or use My Library.');
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      showError((body && body.error && body.error.message) || 'This chapter could not be loaded.');
      return;
    }
    const html = await response.text();
    iframe.srcdoc = html;
    await new Promise((resolve) => {
      iframe.addEventListener('load', resolve, { once: true });
    });
    applyControlledEpubTheme(iframe);

    const chapterPercent = Math.round(((index + 1) / controlledEpubSpine.length) * 100);
    pageIndicatorEl.textContent = `Chapter ${index + 1} of ${controlledEpubSpine.length}`;
    progressFillEl.style.width = `${chapterPercent}%`;
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= controlledEpubSpine.length - 1;
    highlightActiveTocEntry(href);

    // Phase 5 fix — real chapter-index percentage, not the always-0
    // computeEpubPercent() fallback (see scheduleEpubProgressSave()'s
    // own comment); reuses the exact value just computed for the
    // visible progress bar above, so the two can never disagree.
    if (!options.skipProgressSave) scheduleEpubProgressSave(`spine:${href}`, chapterPercent);

    document.dispatchEvent(
      new CustomEvent('library-reader:page-changed', { detail: { currentPage: index + 1, totalPages: controlledEpubSpine.length } })
    );
    // Phase 4 (Robayer AI chapter-context architecture) — same event the
    // legacy epub.js path already dispatches (see handleEpubRelocated()'s
    // own comment on 'library-reader:section-changed'), so
    // library-ai-panel.js has one uniform way to learn the reader's
    // current chapter href regardless of which EPUB path is active.
    document.dispatchEvent(new CustomEvent('library-reader:section-changed', { detail: { href } }));
  }

  /** Controlled-path counterpart to flushEpubProgressOnUnload() (which is epub.js/epubRendition-specific and cannot be reused here): best-effort, synchronous-only local cache write on pagehide, matching the existing "a failed/incomplete save must never interrupt reading" discipline. */
  /**
   * Phase 5 fix (Priority D audit finding): this previously wrote only
   * to localStorage, unlike flushEpubProgressOnUnload() (the legacy
   * path's equivalent, which also fires a `keepalive` request) - a
   * customer who changed chapter and closed the tab within the same
   * PROGRESS_WRITE_DEBOUNCE_MS window as that change would have that
   * final chapter never reach the server at all, only this device's
   * local cache. Mirrors flushEpubProgressOnUnload()'s own reasoning for
   * why a manual keepalive fetch is used here instead of the async
   * customerFetch() saveEpubProgress() normally goes through.
   */
  function flushControlledEpubProgressOnUnload() {
    if (controlledEpubSpine.length === 0) return;
    const href = controlledEpubSpine[controlledEpubChapterIndex] && controlledEpubSpine[controlledEpubChapterIndex].href;
    if (!href) return;
    if (epubCfiSaveTimer) clearTimeout(epubCfiSaveTimer);
    const cfi = `spine:${href}`;
    try {
      localStorage.setItem(epubProgressKey(currentAssetId), JSON.stringify({ cfi, updatedAt: Date.now() }));
    } catch {
      // non-fatal
    }
    const percentComplete = Math.round(((controlledEpubChapterIndex + 1) / controlledEpubSpine.length) * 100);
    const csrf = window.CustomerDashboard.getCsrfToken();
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Customer-CSRF-Token'] = csrf;
    fetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ assetId: currentAssetId, cfi, percentComplete }),
      keepalive: true,
    }).catch(() => {});
  }

  function wireControlledEpubControls() {
    window.addEventListener('pagehide', flushControlledEpubProgressOnUnload);
    prevBtn.addEventListener('click', () => renderControlledEpubChapter(controlledEpubChapterIndex - 1));
    nextBtn.addEventListener('click', () => renderControlledEpubChapter(controlledEpubChapterIndex + 1));
    // In-book search and font-size stepping are epub.js-specific
    // features not reimplemented for this deliberately smaller controlled
    // path. Search stays hidden (its default state). The zoom buttons
    // default to VISIBLE (PDF reuses them for real zoom, so the markup
    // doesn't hide them by default) - explicitly hidden here rather
    // than left visible with no handler attached, which would be a
    // dead, non-functional control.
    zoomInBtn.hidden = true;
    zoomOutBtn.hidden = true;
    const themeObserver = new MutationObserver(() => {
      const iframe = controlledEpubIframe();
      if (iframe) applyControlledEpubTheme(iframe);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('pagehide', () => themeObserver.disconnect());

    if (bookmarkAddBtn) {
      bookmarkAddBtn.hidden = false;
      wireBookmarkControls(
        () => ({ cfi: `spine:${controlledEpubSpine[controlledEpubChapterIndex].href}` }),
        (position) => {
          if (typeof position.cfi === 'string' && position.cfi.startsWith('spine:')) {
            const href = position.cfi.slice('spine:'.length);
            const idx = controlledEpubSpine.findIndex((item) => item.href === href);
            if (idx !== -1) renderControlledEpubChapter(idx);
          }
        }
      );
    }
    // wireEpubDrawers() wires both TOC and Search open/close, but only
    // the TOC trigger is ever unhidden above - the search button stays
    // hidden (its default state), so its own listener here is simply
    // unreachable, not a functional gap. Neither depends on
    // epubRendition, so this is safe to reuse as-is in the controlled path.
    if (tocTriggerBtn) tocTriggerBtn.hidden = false;
    wireEpubDrawers();
  }

  async function openEpubReadSessionControlled(reference, asset, controlledSession, jumpCfi) {
    controlledEpubSessionToken = controlledSession.token;
    controlledEpubSpine = controlledSession.spine || [];
    if (controlledEpubSpine.length === 0) {
      showError('This resource could not be opened right now. Please try again, or download it instead from My Library.');
      return;
    }

    canvasWrap.classList.add('reader-canvas-wrap--epub');
    tocListEl.innerHTML = '';
    renderTocItems(
      controlledEpubSpine.map((item, i) => ({ label: `Chapter ${i + 1}`, href: item.href })),
      tocListEl,
      (href) => {
        const idx = controlledEpubSpine.findIndex((item) => item.href === href);
        if (idx !== -1) renderControlledEpubChapter(idx);
      }
    );

    wireControlledEpubControls();

    let startIndex = 0;
    let resumeNotice = null;
    if (jumpCfi && jumpCfi.startsWith('spine:')) {
      const idx = controlledEpubSpine.findIndex((item) => item.href === jumpCfi.slice('spine:'.length));
      if (idx !== -1) {
        startIndex = idx;
        resumeNotice = 'Jumped to your bookmark.';
      }
    } else {
      const savedCfi = await loadEpubProgress(reference, asset.assetId);
      if (savedCfi && savedCfi.startsWith('spine:')) {
        const idx = controlledEpubSpine.findIndex((item) => item.href === savedCfi.slice('spine:'.length));
        if (idx !== -1) {
          startIndex = idx;
          resumeNotice = 'Resumed from where you left off.';
        }
      }
    }

    await renderControlledEpubChapter(startIndex, { skipProgressSave: true });

    if (resumeNotice) {
      resumeBannerTextEl.textContent = resumeNotice;
      resumeBannerEl.hidden = false;
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        renderControlledEpubChapter(0);
      });
    }

    dispatchReaderReady(reference, asset.assetId, currentProductSlug, titleEl.textContent, false);
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
  async function openReadSession(reference, asset, savedProgress, jumpPage) {
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

    // A bookmark deep-link (see getQueryParams()'s own comment) takes
    // priority over the saved reading position - the customer explicitly
    // asked to jump here from the Library's Bookmarks view. Same
    // "genuinely valid in THIS document" guard as the resume decision
    // below; an invalid/out-of-range page number just falls back to the
    // normal resume behavior rather than erroring.
    const jumpPageNum = jumpPage ? parseInt(jumpPage, 10) : NaN;
    const validJump = Number.isInteger(jumpPageNum) && jumpPageNum >= 1 && jumpPageNum <= pdfDoc.numPages;

    // Resume decision: only jump to a saved page if it's genuinely
    // still a valid, in-progress position in THIS document - a stale
    // currentPage beyond the real page count (e.g. the file changed)
    // just falls back to page 1 rather than erroring.
    const canResume =
      !validJump &&
      savedProgress &&
      savedProgress.status !== 'completed' &&
      typeof savedProgress.currentPage === 'number' &&
      savedProgress.currentPage > 1 &&
      savedProgress.currentPage <= pdfDoc.numPages;

    currentPage = validJump ? jumpPageNum : canResume ? savedProgress.currentPage : 1;
    if (canResume && savedProgress.currentPage >= pdfDoc.numPages) completionAlreadyReported = true;
    wireControls();
    window.addEventListener('pagehide', flushProgressOnUnload);
    await renderPage(currentPage);

    if (validJump) {
      resumeBannerTextEl.textContent = `Jumped to your bookmark — page ${jumpPageNum}.`;
      resumeBannerEl.hidden = false;
      resumeRestartBtn.addEventListener('click', () => {
        resumeBannerEl.hidden = true;
        goToPage(1);
      });
    } else if (canResume) {
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
  function isSiteDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  /**
   * Selects the epub.js theme ('light'/'dark', registered from
   * EPUB_READING_THEMES) matching the site's current data-theme, and
   * is re-run live if that attribute ever changes while a chapter is
   * open (see the MutationObserver set up once in
   * openEpubReadSession() below — theme-toggle.js has no change event
   * of its own, and a MutationObserver on this file's own DOM read is
   * a non-invasive way to react to it without modifying that shared,
   * site-wide file). themes.select() is synchronous, touches only
   * CSS/class state on the currently-rendered content, and never
   * triggers a pagination/layout recalculation (confirmed in the
   * vendored epub.js source — Themes.select() → update() → add() →
   * CSSStyleSheet.insertRule()), so this is deliberately NOT routed
   * through queueEpubOperation() like next()/prev()/display()/resize()
   * are. It can't race a chapter transition either: epub.js's own
   * content hook re-applies whichever theme is current to every
   * newly-created chapter view at creation time, reading that value
   * fresh each time, regardless of exactly when a theme switch and a
   * navigation happen to overlap.
   */
  function applyEpubReadingTheme() {
    if (!epubRendition) return;
    epubRendition.themes.select(isSiteDarkTheme() ? 'dark' : 'light');
  }

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
   * Serializes every epub.js-mutating call this file makes — display(),
   * next(), prev(), resize() — through one promise chain, so two never
   * execute concurrently against the same rendition. See the
   * epubOperationChain declaration above for the exact vendored-source
   * evidence this is fixing. A rejected operation never breaks the
   * chain for the next queued one; it surfaces a real, visible render-
   * error state instead of leaving the canvas silently blank (see
   * showEpubRenderError() below) — never console-only, and never
   * masked with display:none/visibility:hidden on content that's
   * genuinely still there.
   */
  /**
   * How long a single queued operation is allowed to block the rest of
   * the queue before this file forces the queue to move on regardless
   * of whether the underlying epub.js call has actually settled. Real
   * chapter transitions in this book measured well under 2s; this is a
   * bound on correctness (the queue must never deadlock), not a
   * normal-path timing budget — see this function's own comment for
   * why it's needed at all.
   */
  const EPUB_BUSY_SAFETY_TIMEOUT_MS = 8000;

  function queueEpubOperation(operation) {
    const run = () => {
      canvasWrap.classList.add('reader-canvas-wrap--busy');
      // Confirmed live, not hypothetical: a sufficiently pathological
      // epub.js-internal failure (reproduced with a deliberately
      // malformed CFI — no real code path in this app can ever produce
      // one) can leave epub.js's own internal state confused enough
      // that the promise this operation returns never settles AT ALL,
      // even though a LATER call recovers real, correct content. An
      // ordinary `.then()` chain attached only to that promise would
      // therefore never run either — meaning every operation queued
      // AFTER this one would be blocked forever too, a genuine
      // deadlock, not just a stuck-looking UI. Promise.race() against a
      // plain, independent timeout is what guarantees run()'s own
      // returned promise — and so the shared epubOperationChain itself
      // — always settles within EPUB_BUSY_SAFETY_TIMEOUT_MS regardless
      // of what the underlying epub.js promise ever does, so the queue
      // can never be blocked longer than that bound. If the operation
      // genuinely does complete later, its own .then()/.catch() below
      // still run then and update the UI correctly at that point — this
      // only bounds how long everything ELSE has to wait behind it.
      //
      // Real bug found and fixed here (live-instrumented, not assumed):
      // the timer backing safetyTimeout was never cancelled once attempt
      // won the race, so on completely NORMAL navigation (confirmed live:
      // every ordinary next()/prev()/display() actually settles in well
      // under 100ms) this still fired 8 seconds later and logged a false
      // "exceeded the safety timeout" error — every single page turn, for
      // every reader session, regardless of whether anything was ever
      // actually wrong. clearTimeout() below is what makes that log line
      // mean what it says: a genuine, otherwise-never-settling operation,
      // not routine noise on top of completely healthy navigation.
      let safetyTimer;
      const attempt = Promise.resolve()
        .then(operation)
        .then(() => {
          clearTimeout(safetyTimer);
          hideEpubRenderError();
        })
        .catch((error) => {
          clearTimeout(safetyTimer);
          console.error('[library-reader] EPUB operation failed', error);
          showEpubRenderError();
        });
      const safetyTimeout = new Promise((resolve) => {
        safetyTimer = setTimeout(() => {
          console.error('[library-reader] EPUB operation exceeded the safety timeout — releasing the queue without it');
          resolve();
        }, EPUB_BUSY_SAFETY_TIMEOUT_MS);
      });
      return Promise.race([attempt, safetyTimeout]).then(() => {
        canvasWrap.classList.remove('reader-canvas-wrap--busy');
        // A real relocated event (handleEpubRelocated) is the normal,
        // authoritative way the render-error state clears. Reached here
        // only once the safety timeout has already won the race, so a
        // genuine relocation in the meantime is the best evidence
        // available that content actually recovered — trust it the
        // same way handleEpubRelocated itself does.
        if (epubRendition && epubRendition.currentLocation && epubRendition.currentLocation().start) hideEpubRenderError();
      });
    };
    epubOperationChain = epubOperationChain.then(run, run);
    return epubOperationChain;
  }

  /**
   * Resize specifically — queued like everything else above, and
   * passes the CURRENT cfi as resize()'s own third argument rather than
   * this file re-implementing "remember and restore position" by hand:
   * Rendition.onResized() (confirmed in the vendored source) already
   * redisplays exactly that cfi once the manager's relayout finishes,
   * so this uses epub.js's own native position-preserving path instead
   * of a bespoke one. Skips a resize outright while the container is
   * momentarily unmeasurable (e.g. mid-orientation-change, or a
   * hidden/backgrounded tab) rather than laying out against a bogus
   * 0×0 size — a later resize (epub.js's own internal listener, or the
   * next font-size change) simply retries once the container is
   * measurable again.
   */
  function queueEpubResize() {
    return queueEpubOperation(() => {
      if (!epubRendition) return;
      if (canvasWrap.clientWidth === 0 || canvasWrap.clientHeight === 0) return;
      const loc = epubRendition.currentLocation();
      const cfi = (loc && loc.start && loc.start.cfi) || lastKnownGoodCfi;
      return epubRendition.resize(undefined, undefined, cfi || undefined);
    });
  }

  /**
   * A true fallback for a genuine render failure — a queued operation
   * actually threw/rejected — never a mask for content that's still
   * really there. Self-heals the moment any later operation succeeds or
   * a real relocation fires (see handleEpubRelocated()), so it never
   * lingers once the reader has recovered.
   */
  function showEpubRenderError() {
    if (epubRenderErrorEl) epubRenderErrorEl.hidden = false;
  }
  function hideEpubRenderError() {
    if (epubRenderErrorEl) epubRenderErrorEl.hidden = true;
  }

  /**
   * Defensive safety net beyond queueEpubOperation()'s own .catch() —
   * confirmed live, not hypothetical: a genuinely malformed CFI (e.g.
   * corrupted saved progress/bookmark data) can make epub.js's internal
   * CFI parsing throw a plain, UNCAUGHT error on a delayed tick inside
   * its own queue internals, decoupled from the promise
   * queueEpubOperation() is actually chained to — one that never
   * reaches that function's own .catch() no matter how it's written,
   * because by the time it fires the operation's own promise has
   * already settled (however it settled) and the queue has moved on.
   * Gated on canvasWrap still carrying `reader-canvas-wrap--busy` (i.e.
   * a queued operation is genuinely still in flight right now) —
   * confirmed live this matters: without that gate, a stray error from
   * an ALREADY-superseded failed attempt can arrive after a LATER,
   * genuinely successful operation already hid the error state, and
   * incorrectly re-show it over content that's actually fine. Also
   * scoped to errors that plausibly originate from epub.js itself
   * (checked via the error's own filename/stack) so this never
   * mistakes an unrelated page error for a render failure.
   */
  function looksLikeEpubJsError(source) {
    return typeof source === 'string' && /epub\.min\.js|epubjs/i.test(source);
  }
  window.addEventListener('error', (event) => {
    if (!epubRendition || !canvasWrap.classList.contains('reader-canvas-wrap--busy')) return;
    if (!looksLikeEpubJsError(event.filename) && !looksLikeEpubJsError(event.error && event.error.stack)) return;
    console.error('[library-reader] Uncaught EPUB render error', event.error || event.message);
    showEpubRenderError();
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (!epubRendition || !canvasWrap.classList.contains('reader-canvas-wrap--busy')) return;
    const stack = event.reason && event.reason.stack;
    if (!looksLikeEpubJsError(stack)) return;
    console.error('[library-reader] Unhandled EPUB render rejection', event.reason);
    showEpubRenderError();
  });

  /**
   * Phase 9C.5 — the actual EPUB reading experience, built on the
   * Phase 9C.4 CSP-hardened foundation: chapter navigation, TOC,
   * search, font size, and resume. Reuses the exact same read-access
   * token/Blob pipeline openReadSession() (above) already uses for
   * PDF - entitlement/access control is untouched here, only the
   * format differs. AI citations and annotations are explicitly not
   * part of this phase.
   */
  async function openEpubReadSession(reference, asset, jumpCfi) {
    dispatchReaderReady(reference, asset.assetId, currentProductSlug, titleEl.textContent, true);
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
    // Rendering architecture — 'scrolled-doc' flow, not the default
    // paginated (CSS multi-column) flow a much earlier version of this
    // file used. Root-caused directly, live, against the real GSE book:
    // the paginated flow renders an entire chapter into ONE very wide
    // multi-column iframe and pages through it by scrolling an ANCESTOR
    // element horizontally. Using Range.getClientRects() (real layout
    // geometry) against document.elementFromPoint() (real paint/hit-
    // test state), both read from INSIDE the chapter iframe's own
    // document, proved that content in any column beyond whichever one
    // was on-screen when that iframe was first inserted was correctly
    // laid out but never actually painted or hit-testable - a genuinely
    // blank page, 100% reproducible, on every chapter tested, at every
    // viewport tested. No CSS/paint workaround fixed it (forced reflow,
    // resize, GPU-layer promotion via transform/will-change, and even
    // epub.js's own official manager.resize()/view.reframe() APIs were
    // all tried and all failed) - the ONLY thing that worked was
    // force-reloading the iframe, which also destroyed this reader's
    // injected theme/CSS state and epub.js's own internal view wiring,
    // an unacceptable trade-off for a production reader.
    // 'scrolled-doc' avoids the specific combination that triggers this
    // (CSS multi-column layout + horizontal ancestor-scroll of a huge
    // iframe) entirely: it lays each chapter out as ordinary vertical
    // document flow in an iframe scrolled VERTICALLY by an ancestor -
    // architecturally the exact same "ancestor scrolls a big iframe"
    // shape, but without CSS columns. Verified directly, the same way
    // the bug itself was found: walked Range.getClientRects()/
    // elementFromPoint() across the full height of multiple real
    // chapters, across multiple real books (including one much larger
    // than this one), through repeated virtual-page navigation,
    // font-size changes, and container resizes - zero paint/hit-test
    // failures anywhere, at any depth. This is a well-supported,
    // documented epub.js flow (not an undocumented internal hack),
    // deliberately NOT combined with epub.js's own paginated-vertical
    // internal mode (isPaginated + axis:'vertical' does exist in the
    // vendored source, but is not reachable through any public
    // configuration option - only by mutating manager internals
    // directly, which is exactly the kind of unsupported hack this
    // phase's fix is trying to get away from).
    //
    // A much earlier version of this comment claimed 'scrolled-doc'
    // "never resolves display()" in this reader's actual layout. That
    // was re-tested directly against this exact canvasWrap/CSS this
    // phase, including while canvasWrap starts hidden and the PDF
    // canvas is display:none (the exact circumstances Phase 9C.10's own
    // fix above was about) - display() resolves correctly and
    // reliably. Whatever caused that original observation, it isn't
    // reproducible now; if it resurfaces, it needs its own root-cause
    // investigation rather than reverting to the multi-column flow this
    // phase just proved is unsafe for production.
    //
    // "Pages" are now an application-level concept the paginated flow
    // used to provide for free - epubAdvancePage() below (used by both
    // the toolbar buttons and arrow-key navigation) turns a Next/Prev
    // press into "scroll the chapter by one viewport, or cross into the
    // next/previous chapter at a boundary" using epub.js's own public
    // manager.scrollBy()/next()/prev() APIs - never a raw DOM/scroll
    // hack. Progress/percentage/TOC-highlighting need no changes at
    // all: epub.js's 'relocated' event (handleEpubRelocated, wired
    // below) fires correctly off BOTH this app-level page-turn AND any
    // organic mouse-wheel/touch scroll the customer does directly on
    // the chapter (confirmed live) - this reader is not turning that
    // off, since free scrolling is a genuine improvement over the old
    // paginated flow's fixed page boundaries, not a regression.
    epubRendition = epubBook.renderTo(canvasWrap, { width: '100%', height: '100%', flow: 'scrolled-doc' });
    epubRendition.on('relocated', handleEpubRelocated);
    epubRendition.on('rendered', cleanupDuplicateEpubContainers);
    // Mobile reader fix — a real stylesheet injected into every rendered
    // chapter via epub.js's own theming API (Rendition.themes.default()),
    // not a page-level CSS hack: the EPUB's own content must never be
    // able to force horizontal overflow regardless of how a given book
    // was authored (an oversized image, a wide table, an un-breakable
    // long word/URL). Scoped entirely to the chapter document epub.js
    // controls - never touches this app's own DOM/CSS.
    epubRendition.themes.default({
      // Structural safety rules — unrelated to the flow/architecture
      // decision above (these apply identically whether the chapter is
      // laid out in columns or, as now, plain vertical flow): the
      // book's own content must never be able to force horizontal
      // overflow regardless of how it was authored. No column-gap rule
      // here any more - that was a fix for a CSS-multicolumn pagination
      // math bug (epub.js's paginated Layout.calculate() under-counting
      // column-gap in its Next()/Prev() scroll distance) that doesn't
      // exist for 'scrolled-doc' flow, which uses no CSS columns at
      // all.
      'html, body': { 'max-width': '100%', 'overflow-x': 'hidden', 'box-sizing': 'border-box' },
      'img, svg, video': { 'max-width': '100%', height: 'auto' },
      table: { 'max-width': '100%', display: 'block', 'overflow-x': 'auto' },
      // Targeted at the actual block content the book's text lives in
      // (per the brief's own list: headings, paragraphs, lists, quotes)
      // rather than a blanket `*` — a universal max-width/box-sizing
      // override risks distorting an EPUB's own inline/table-based
      // layout choices, which this fix has no reason to touch.
      'p, div, section, article, h1, h2, h3, h4, h5, h6, li, blockquote, pre': {
        'max-width': '100%',
        'overflow-wrap': 'break-word',
        'word-wrap': 'break-word',
      },
    });
    // White-flash/readability fix — registers the two named themes
    // from EPUB_READING_THEMES (composed together with the safety
    // rules above, not replacing them — epub.js applies every
    // registered theme matching either 'default' or the current
    // selection to each rendered chapter) and selects the one
    // matching the site's current dark/light mode. The observer keeps
    // that selection correct if the customer toggles the site's own
    // theme while a chapter is already open — disconnected on
    // pagehide alongside this file's other unload cleanup, since
    // nothing after that point can still call applyEpubReadingTheme().
    epubRendition.themes.register(EPUB_READING_THEMES);
    applyEpubReadingTheme();
    const epubThemeObserver = new MutationObserver(applyEpubReadingTheme);
    epubThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('pagehide', () => epubThemeObserver.disconnect());

    epubBook.loaded.navigation
      .then((nav) => {
        tocListEl.innerHTML = '';
        renderTocItems(nav.toc, tocListEl);
      })
      .catch(() => {
        // non-fatal - TOC just stays empty; chapter prev/next still works
      });

    const savedCfi = await loadEpubProgress(reference, asset.assetId);
    // A bookmark deep-link (see getQueryParams()'s own comment) takes
    // priority over the saved reading position, same as the PDF path
    // above.
    const displayTarget = jumpCfi || savedCfi;
    try {
      if (displayTarget) {
        await epubRendition.display(displayTarget);
        resumeBannerTextEl.textContent = jumpCfi ? 'Jumped to your bookmark.' : 'Resumed from where you left off.';
        resumeBannerEl.hidden = false;
        if (!jumpCfi && window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-shown', currentProductSlug);
        resumeRestartBtn.addEventListener('click', () => {
          resumeBannerEl.hidden = true;
          if (!jumpCfi && window.RobayerAnalytics) window.RobayerAnalytics.trackLibraryEvent('library-resume-restarted', currentProductSlug);
          queueEpubOperation(() => epubRendition.display());
        });
      } else {
        await epubRendition.display();
      }
    } catch {
      // Phase 9C.5 — an invalid/stale saved CFI (e.g. the file changed
      // since it was saved) must never crash the reader; fall back to
      // the beginning exactly like a first-time open, and clear the
      // now-untrustworthy saved position rather than trying it again
      // next time. A bookmark's own cfi failing is a stale BOOKMARK, not
      // corrupted saved progress - never clear real reading progress
      // over that.
      if (!jumpCfi) clearEpubProgress(asset.assetId);
      try {
        await epubRendition.display();
      } catch {
        removeLoadingNotice();
        showError('This file could not be displayed. Please try again, or download it instead from My Library.');
        return;
      }
    }

    removeLoadingNotice();
    // Blank-canvas root-cause fix — controls are wired only once the
    // FIRST display() above has genuinely resolved, not before: with
    // the toolbar visible (and interactive) from the moment the
    // "Loading your book…" notice appears, a customer tapping
    // Next/Zoom during that async window used to be able to fire
    // straight into a rendition that hadn't finished its first
    // display() yet - exactly the kind of overlapping-operation race
    // this whole fix is about closing. Wiring the controls here instead
    // means every click these listeners can possibly produce is
    // already safely behind this point.
    wireEpubControls();
    wireEpubDrawers();
    // Mobile reader fix — a one-time safety-net resize/relayout once
    // the reader is actually done loading. `renderTo(canvasWrap,
    // {width:'100%', height:'100%'})` measures the container at the
    // moment it's called, which is before the "Loading your book…"
    // notice above is removed and before the resume banner/toolbar have
    // necessarily finished their own layout - on a phone, where every
    // pixel of width is already tight, a stale measurement from
    // mid-load is exactly the kind of thing that produces
    // "desktop-style dimensions" on first open. Routed through
    // queueEpubResize() like every other epub.js-mutating call now
    // (see that function's own comment) rather than calling
    // epubRendition.resize() directly.
    queueEpubResize();
    ensureEpubLocationsGenerated();
  }

  /**
   * How much of the viewport a single Next/Prev press scrolls by, as a
   * fraction of the chapter container's own height. Deliberately not
   * 1.0 — a small overlap (matching the "keep the last line or two in
   * view" convention real e-readers and PDF viewers already use) so a
   * page turn never drops the customer mid-sentence with no visual
   * continuity from the page before.
   */
  const EPUB_PAGE_SCROLL_OVERLAP = 0.92;

  /**
   * Bound on how long epubAdvancePage() will wait, after a chapter
   * transition, for that chapter's content to actually become visible
   * before giving up and surfacing the EXISTING render-error/Retry
   * state (showEpubRenderError() - never a new UI element, never a
   * silently blank canvas). NOT a normal-path timing budget - every
   * transition measured in this environment resolves in well under
   * 100ms - a correctness bound for the rare case content genuinely
   * never appears, matching EPUB_BUSY_SAFETY_TIMEOUT_MS's own
   * reasoning above (queueEpubOperation()).
   */
  const EPUB_CHAPTER_PAINT_TIMEOUT_MS = 4000;
  const EPUB_CHAPTER_PAINT_POLL_MS = 50;

  /**
   * A real, condition-checked wait - never a blind fixed-duration
   * delay - for the new chapter's text to actually be painted/
   * hit-testable, not merely present in the DOM. Exists because
   * epub.js's own next()/prev() promise (confirmed in the vendored
   * source: Rendition._display() resolves once manager.display()'s
   * promise settles) resolves once the new section's view has been
   * built and its render/content hooks have run - it does NOT wait for
   * the browser to have actually PAINTED that content on screen, and
   * those are two different moments. This reader's own architecture
   * investigation (see openEpubReadSession()'s header comment) already
   * established that document.elementFromPoint() - not DOM/text
   * presence alone - is the only reliable signal for "is this content
   * actually rendered", since a real customer-reported blank-page bug
   * previously reproduced with the DOM/text fully present the whole
   * time. Walks every real (non-whitespace) text node's own laid-out
   * position via Range.getClientRects() rather than one fixed
   * coordinate, so a chapter that starts with a wide top margin or
   * empty heading space can't produce a false "not painted yet" read.
   * Resolves true the moment ANY real text position hit-tests to a
   * real element; resolves false only once EPUB_CHAPTER_PAINT_TIMEOUT_MS
   * has genuinely elapsed with nothing ever confirmed.
   */
  function waitForEpubChapterPaint() {
    return new Promise((resolve) => {
      const deadline = Date.now() + EPUB_CHAPTER_PAINT_TIMEOUT_MS;
      const check = () => {
        const iframe = canvasWrap.querySelector('iframe');
        const doc = iframe && iframe.contentDocument;
        const body = doc && doc.body;
        if (doc && body) {
          const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              return node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            },
          });
          const range = doc.createRange();
          let node = walker.nextNode();
          while (node) {
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.width <= 0 || rect.height <= 0) continue;
              const el = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              if (el && el !== doc.documentElement && el !== body) {
                resolve(true);
                return;
              }
            }
            node = walker.nextNode();
          }
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(check, EPUB_CHAPTER_PAINT_POLL_MS);
      };
      check();
    });
  }

  /**
   * Turns a Next/Prev press into "page" navigation for the
   * 'scrolled-doc' flow (see openEpubReadSession()'s own header comment
   * on that flow choice) — a flow with no inherent page concept of its
   * own; epub.js's next()/prev() jump a whole SECTION at a time under
   * it, which is correct chapter-boundary behavior but too coarse to
   * be this reader's only Next/Prev granularity. Only ever touches the
   * DOM through epub.js's own public APIs — manager.scrollBy() for the
   * within-chapter case (the exact same method epub.js's own internal
   * next()/prev() call for its paginated-vertical mode; confirmed in
   * the vendored source), epubRendition.next()/prev() for genuine
   * chapter transitions. Never a raw scrollTop/scrollLeft assignment,
   * a forced reflow, a resize, or any of the other techniques this
   * phase's investigation tried and rejected for the old flow.
   *
   * `direction` is 1 for Next, -1 for Prev. Boundary detection reads
   * the manager's own live container (`epubRendition.manager.container`)
   * rather than re-querying `.epub-container` from this file's own DOM
   * lookup, so this can never target a stale/duplicate container (see
   * cleanupDuplicateEpubContainers()'s own header comment for why more
   * than one can transiently exist).
   */
  async function epubAdvancePage(direction) {
    const manager = epubRendition && epubRendition.manager;
    const container = manager && manager.container;
    if (!container) return;
    const atEdge =
      direction > 0
        ? container.scrollTop + container.clientHeight >= container.scrollHeight - 1
        : container.scrollTop <= 1;
    if (atEdge) {
      await (direction > 0 ? epubRendition.next() : epubRendition.prev());
      // See waitForEpubChapterPaint()'s own header comment for exactly
      // why this is needed on top of next()/prev()'s own promise, and
      // why it's a bounded, condition-checked wait rather than a
      // fixed-duration delay. A false result throws (never a silent
      // no-op) so queueEpubOperation()'s existing catch() surfaces the
      // existing render-error/Retry UI, exactly like any other genuine
      // navigation failure.
      const painted = await waitForEpubChapterPaint();
      if (!painted) throw new Error('EPUB chapter content did not become visible after navigation');
      return;
    }
    const amount = container.clientHeight * EPUB_PAGE_SCROLL_OVERLAP * direction;
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const targetScrollTop = Math.min(Math.max(container.scrollTop + amount, 0), maxScrollTop);
    manager.scrollBy(0, targetScrollTop - container.scrollTop, false);
  }

  function wireEpubControls() {
    prevBtn.addEventListener('click', () => queueEpubOperation(() => epubAdvancePage(-1)));
    nextBtn.addEventListener('click', () => queueEpubOperation(() => epubAdvancePage(1)));
    zoomOutBtn.setAttribute('aria-label', 'Decrease font size');
    zoomInBtn.setAttribute('aria-label', 'Increase font size');
    zoomOutBtn.addEventListener('click', () => setEpubFontSize(epubFontIndex - 1));
    zoomInBtn.addEventListener('click', () => setEpubFontSize(epubFontIndex + 1));
    tocTriggerBtn.hidden = false;
    searchTriggerBtn.hidden = false;

    canvasWrap.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') queueEpubOperation(() => epubAdvancePage(1));
      if (event.key === 'ArrowLeft') queueEpubOperation(() => epubAdvancePage(-1));
    });

    // Mirrors flushProgressOnUnload()'s own reasoning above: the
    // debounced save from the most recent relocation may not have
    // fired yet by the time the customer navigates away.
    window.addEventListener('pagehide', flushEpubProgressOnUnload);

    // Blank-canvas root-cause fix — the manual, independently-debounced
    // (150ms) window-resize listener the earlier "mobile reader fix"
    // phase added here is REMOVED, not kept: confirmed directly in the
    // vendored epub.js source (js/vendor/epubjs/epub.min.js) that
    // DefaultViewManager already installs its OWN automatic,
    // internally-debounced (50ms) `window.resize` listener whenever the
    // rendition isn't given fixed numeric width/height - which is
    // exactly this reader's own configuration (renderTo(canvasWrap,
    // {width:'100%', height:'100%'})). Keeping both meant every single
    // window resize (including an orientation change, which epub.js's
    // Stage also already listens for on its own) fired TWO independent,
    // differently-timed clear()+relayout cycles against the same
    // rendition - each capable of clearing the view the other was still
    // mid-render into. This was never "the resize fix is wrong to
    // exist"; it's that this file was redundantly re-implementing a
    // mechanism epub.js's own lifecycle already provides, and the
    // duplication itself was the race. The one case epub.js's own
    // listener CANNOT cover - a font-size change, which fires no window
    // 'resize' event at all - still gets its own, now-queued resize
    // call; see setEpubFontSize()'s own comment.
    if (epubRenderRetryBtn) {
      epubRenderRetryBtn.addEventListener('click', () => {
        queueEpubOperation(() => epubRendition.display(lastKnownGoodCfi || undefined));
      });
    }

    // Phase J.2.1 — the EPUB counterpart of wireControls()'s own
    // `library-ai-panel:go-to-page` listener (below, PDF-only). Reads
    // `cfi` instead of `pageNumber` from the same event, and navigates
    // with the exact same epubRendition.display() call already used for
    // TOC entries, search results, and bookmark jumps in this file — no
    // new navigation mechanism, no new trust boundary. `cfi` only ever
    // comes from this resource's own already-entitled AI response (see
    // answerService.ts's documentId scoping), never from anything
    // user-suppliable, so this can never navigate outside the book
    // that's actually loaded in this epubRendition.
    document.addEventListener('library-ai-panel:go-to-page', (event) => {
      if (event.detail.cfi) queueEpubOperation(() => epubRendition.display(event.detail.cfi));
    });

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
        if (bookmark.cfi) queueEpubOperation(() => epubRendition.display(bookmark.cfi));
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

  /**
   * Phase 9C.5 — TOC and search share one drawer treatment (see
   * css/components.css's .reader-drawer); only one is ever open at a
   * time.
   *
   * Drawer auto-close fix — real, pre-existing bug (present since
   * a038e5b, well before this fix): openReaderDrawer() calls
   * closeReaderDrawers() first, to close whichever OTHER drawer might
   * already be open. But closeReaderDrawers() unconditionally scheduled
   * a 220ms-delayed `hidden = true` on ALL panels regardless of what
   * happened next - so that stale timeout fired 220ms after every
   * single open, hiding the drawer that had just been opened. Confirmed
   * directly: a drawer was genuinely visible at 100ms and force-hidden
   * by 300-400ms, every time, for both TOC and Search independently.
   *
   * The fix is in closeReaderDrawers()'s own timeout callback, not
   * here: it now only hides a panel that is STILL actually meant to be
   * closed at the moment the timeout fires (i.e. still lacks
   * `reader-drawer--open`) — never one a later openReaderDrawer() call
   * already reopened (and re-added `--open` to) in the meantime. This
   * is deliberately not "cancel the timer on open": doing that would
   * leave whichever drawer was open a moment ago with `hidden` never
   * set back to `true` when switching straight from one drawer to
   * another (e.g. TOC → Search) — invisible via the CSS transform, but
   * still present in the tab order/accessibility tree, a real if subtle
   * regression this design avoids. The 220ms delay itself is
   * unchanged - it still exists purely so the close transition
   * (`--open` class removal) has time to finish playing before the
   * panel leaves the accessibility tree.
   */
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
    if (drawerHideTimer) clearTimeout(drawerHideTimer);
    drawerHideTimer = setTimeout(() => {
      if (!tocPanel.classList.contains('reader-drawer--open')) tocPanel.hidden = true;
      if (!searchPanel.classList.contains('reader-drawer--open')) searchPanel.hidden = true;
      if (!bookmarksPanel.classList.contains('reader-drawer--open')) bookmarksPanel.hidden = true;
      if (!drawerBackdropEl.classList.contains('reader-drawer-backdrop--visible')) drawerBackdropEl.hidden = true;
      drawerHideTimer = null;
    }, 220);
  }

  /**
   * UI/UX Pro Max mobile toolbar restructuring (blank-canvas fix
   * phase) — Bookmark-add and Bookmarks-list move into this small
   * "More actions" popover ONLY at mobile widths (css/components.css's
   * own media query controls this purely via CSS:
   * `.reader-toolbar__more-panel` is `display:contents` — plain,
   * always-visible toolbar content, no popover — above 640px, and only
   * becomes an actual anchored popover, toggled by this function, at
   * 640px and below). Real math, not a guess: at 320-430px the toolbar
   * cannot fit all 7 controls at the required 44×44px touch-target
   * minimum in one row no matter how they're arranged — the nav group
   * (Prev/indicator/Next) alone already consumes roughly half of a
   * 320px-wide toolbar's available content width. Moving the two least
   * time-pressured actions (adding/viewing a bookmark is never a
   * per-page-turn action, unlike Next/Prev/zoom/TOC/search/Ask Robayer
   * AI) out of the always-visible row is what lets the primary row
   * genuinely fit in one line at realistic phone widths. Called once
   * from wireBookmarkControls() — shared by both the PDF and EPUB
   * paths, since bookmarks (and so this menu) work identically for
   * both formats.
   */
  function wireMoreMenu() {
    if (!moreMenuTriggerBtn || !moreMenuPanel || moreMenuTriggerBtn.hasAttribute('data-bound')) return;
    moreMenuTriggerBtn.setAttribute('data-bound', 'true');
    moreMenuTriggerBtn.hidden = false;

    function closeMoreMenu() {
      moreMenuPanel.classList.remove('reader-toolbar__more-panel--open');
      moreMenuTriggerBtn.setAttribute('aria-expanded', 'false');
    }
    moreMenuTriggerBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = moreMenuPanel.classList.contains('reader-toolbar__more-panel--open');
      if (isOpen) {
        closeMoreMenu();
        return;
      }
      moreMenuPanel.classList.add('reader-toolbar__more-panel--open');
      moreMenuTriggerBtn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('click', (event) => {
      if (!moreMenuPanel.contains(event.target) && event.target !== moreMenuTriggerBtn) closeMoreMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMoreMenu();
    });
    // The menu's own items (bookmarkAddBtn/bookmarksTriggerBtn) have
    // their real click handlers registered by this function's caller
    // (wireBookmarkControls) — this only closes the popover once one of
    // them has actually been activated, since those handlers have no
    // reason to know this popover exists.
    moreMenuPanel.addEventListener('click', (event) => {
      if (event.target.closest('button')) closeMoreMenu();
    });
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
    wireMoreMenu();

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
  /**
   * `onSelect`, added for the controlled EPUB reader (Controlled Library
   * Library): defaults to the pre-existing epub.js navigation
   * (`epubRendition.display()`) when omitted, so every existing legacy
   * caller is completely unaffected. The controlled path passes its own
   * chapter-index navigation instead - epubRendition does not exist in
   * that path at all, so reusing the old default there would either
   * throw or silently fail.
   */
  function renderTocItems(items, container, onSelect) {
    const select = onSelect || ((href) => queueEpubOperation(() => epubRendition.display(href)));
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
          select(item.href);
        });
        li.appendChild(link);
      } else {
        const heading = document.createElement('span');
        heading.className = 'reader-toc__heading';
        heading.textContent = item.label.trim();
        li.appendChild(heading);
      }
      if (item.subitems && item.subitems.length) renderTocItems(item.subitems, li, onSelect);
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
    lastKnownGoodCfi = cfi;
    hideEpubRenderError();
    // A real 'relocated' event only ever fires once epub.js has
    // genuinely displayed something - unambiguous, first-hand proof
    // the canvas is not actually stuck, regardless of what
    // queueEpubOperation()'s own promise bookkeeping currently thinks
    // is still in flight (confirmed live: a sufficiently pathological
    // epub.js-internal failure can leave that bookkeeping believing an
    // operation never finished even after a LATER call has already
    // succeeded and genuinely relocated - trust this actual lifecycle
    // signal over that bookkeeping).
    canvasWrap.classList.remove('reader-canvas-wrap--busy');
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
    if (location.start.href) {
      highlightActiveTocEntry(location.start.href);
      // Digital Library 2.0 Phase H — the one new event this phase adds
      // (the audit found EPUB had no per-chapter equivalent of the
      // existing PDF-only 'library-reader:page-changed'). Fires only
      // when the spine item itself actually changes, not on every
      // scroll/page-turn relocation within the same chapter — mirrors
      // the real href convention library_bookmarks.cfi and
      // library_knowledge_chunks.cfi already use (a real spine href,
      // never a byte-precise CFI).
      if (location.start.href !== lastDispatchedEpubHref) {
        lastDispatchedEpubHref = location.start.href;
        document.dispatchEvent(new CustomEvent('library-reader:section-changed', { detail: { href: location.start.href } }));
      }
    }
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
    // Mobile reader fix — this was the actual root cause of "Font +"
    // appearing to zoom the whole page instead of just the text.
    // themes.fontSize() only changes the CSS font-size inside the
    // chapter iframe; it does NOT re-run epub.js's own paginated-layout
    // measurement, which computed its column/page width once, against
    // whatever the container's size happened to be at that moment.
    // After a font-size change, that stale width no longer matches how
    // much text now fits per "page," and on a narrow mobile viewport
    // the mismatch surfaces as content wider than the screen rather
    // than the harmless letterboxing it'd be on a wide desktop window.
    // epubRendition.resize() with no arguments re-measures the current
    // container and re-lays-out against it — the real fix, not a CSS
    // workaround. Routed through queueEpubResize() (see that function's
    // own comment) rather than called directly, both so it can never
    // overlap an in-flight next()/prev()/display(), and so the current
    // reading position is explicitly preserved across the reflow via
    // epub.js's own native resize(width,height,cfi) parameter, instead
    // of a font-size change silently throwing the customer back to the
    // top of the chapter.
    queueEpubResize();
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
  /**
   * `explicitPercent` — Phase 5 fix (Priority D audit finding): the
   * controlled, chapter-scoped EPUB path (renderControlledEpubChapter())
   * never loads a real epub.js `Book`, so `computeEpubPercent()`'s own
   * `epubBook.locations.percentageFromCfi()` call was silently
   * unreachable for it (`epubLocationsGenerated`/`epubBook` are only
   * ever set by the LEGACY epub.js init path) - every controlled-reader
   * EPUB progress write was landing as a hardcoded 0%, which
   * deriveStatus() (libraryProgressService.ts) then reported as
   * `not_started` regardless of how much of the book had actually been
   * read. Passing the real, already-computed chapter-index percentage
   * (see renderControlledEpubChapter()'s own progressFillEl update) lets
   * the controlled path report a genuine percentage without needing
   * epub.js's locations index at all; omitting it (the legacy path)
   * preserves the exact previous computeEpubPercent(cfi) behavior.
   */
  function scheduleEpubProgressSave(cfi, explicitPercent) {
    if (epubCfiSaveTimer) clearTimeout(epubCfiSaveTimer);
    epubCfiSaveTimer = setTimeout(() => saveEpubProgress(cfi, explicitPercent), PROGRESS_WRITE_DEBOUNCE_MS);
  }
  /** A failed write (local or server) is swallowed on purpose - see writeProgress()'s own header comment; reading must never stop, error, or hesitate because a progress save didn't go through. */
  async function saveEpubProgress(cfi, explicitPercent) {
    const percentComplete = typeof explicitPercent === 'number' ? explicitPercent : computeEpubPercent(cfi);
    try {
      localStorage.setItem(epubProgressKey(currentAssetId), JSON.stringify({ cfi, updatedAt: Date.now() }));
    } catch {
      // non-fatal
    }
    try {
      await window.CustomerDashboard.customerFetch(`/api/customer/purchases/${encodeURIComponent(currentReference)}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: currentAssetId, cfi, percentComplete }),
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
        queueEpubOperation(() => epubRendition.display(result.cfi));
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

  async function goToPage(page) {
    if (!pdfDoc || page < 1 || page > pdfDoc.numPages || rendering) return;
    currentPage = page;
    try {
      await renderPage(currentPage);
    } catch (error) {
      showError(error.message || 'This page could not be loaded. Please try again, or reopen from My Library.');
    }
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
  async function setScale(next) {
    const floor = lastFitScale === null ? MIN_SCALE : Math.min(MIN_SCALE, lastFitScale);
    scale = Math.min(MAX_SCALE, Math.max(floor, next));
    if (!pdfDoc) return;
    try {
      await renderPage(currentPage);
    } catch (error) {
      showError(error.message || 'This page could not be loaded. Please try again, or reopen from My Library.');
    }
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
    try {
      const page = await pdfDoc.getPage(currentPage);
      scale = await computeFitScale(page, page.getViewport({ scale: 1 }).width);
      await renderPage(currentPage);
    } catch (error) {
      showError(error.message || 'This page could not be loaded. Please try again, or reopen from My Library.');
    }
  }

  async function renderPage(pageNumber) {
    rendering = true;
    prevBtn.disabled = pageNumber <= 1;
    nextBtn.disabled = pageNumber >= pdfDoc.numPages;

    // The `rendering` guard above must always clear, even when
    // pdfDoc.getPage() or the render call itself throws (e.g. the
    // controlled shim's per-page fetch failing on an expired/revoked
    // session or a disabled controlled reader - see createControlledPdfDocShim()).
    // Previously this was a bare assignment on the success path only,
    // so a mid-session failure left `rendering` stuck true forever -
    // goToPage()/setScale()/refitAndRerender() all early-return while
    // it's true, so the reader silently stopped responding to every
    // further page-turn/zoom/resize with no visible error. The `finally`
    // guarantees the guard clears either way; callers now catch the
    // rethrown error and show it.
    try {
      const page = await pdfDoc.getPage(pageNumber);
      if (scale === null) scale = await computeFitScale(page, page.getViewport({ scale: 1 }).width);

      // Phase 9A - two viewports, deliberately: `viewport` is the
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

      scheduleProgressWrite(pageNumber, pdfDoc.numPages);
      document.dispatchEvent(new CustomEvent('library-reader:page-changed', { detail: { currentPage: pageNumber, totalPages: pdfDoc.numPages } }));
    } finally {
      rendering = false;
    }
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
