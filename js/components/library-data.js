/**
 * Robayer WealthLab: Library data loader — Phase J.2.3.
 *
 * Four independent Library-home components (library-list.js,
 * library-continue-reading.js, library-ai-entry.js,
 * library-learning-stats.js) each fetched GET /api/customer/purchases
 * on their own, and three of them also independently fetched
 * GET /api/customer/library/progress — up to four duplicate /purchases
 * requests and three duplicate /progress requests on every single
 * Library page load, for the exact same data (see the J.1 audit's
 * Performance finding). This file is not a state-management framework;
 * it is a request cache scoped to exactly those two endpoints. Nothing
 * about how any component renders changes — every component still owns
 * its own DOM, still fails independently (a rejected promise here
 * rejects for every caller, exactly as a direct customerFetch() would),
 * and still decides its own empty/error state.
 *
 * Not persisted beyond this page load (no localStorage/sessionStorage) —
 * a fresh Library visit always fetches fresh data, so this never
 * introduces staleness across visits or across customers on a shared
 * device. Within one page load, the first call to each getter fetches;
 * every later call in the same load reuses that one in-flight/resolved
 * promise. A failed fetch is never cached as a failure — the promise is
 * cleared so the next caller gets a genuine retry, not a permanently
 * poisoned result.
 */
(function () {
  let purchasesPromise = null;
  let progressPromise = null;

  function getPurchases() {
    if (!purchasesPromise) {
      purchasesPromise = window.CustomerDashboard.customerFetch('/api/customer/purchases?limit=50').catch((error) => {
        purchasesPromise = null;
        throw error;
      });
    }
    return purchasesPromise;
  }

  function getProgress() {
    if (!progressPromise) {
      progressPromise = window.CustomerDashboard.customerFetch('/api/customer/library/progress').catch((error) => {
        progressPromise = null;
        throw error;
      });
    }
    return progressPromise;
  }

  /**
   * Explicit invalidation, as required by Phase J.2.3 — forces the next
   * getPurchases()/getProgress() call to genuinely re-fetch instead of
   * reusing an already-resolved result. Not currently called anywhere:
   * nothing on the Library page itself mutates purchases or progress
   * server-side without already updating its own local view directly
   * (e.g. a download's usage count is patched in place on the same
   * asset object library-list.js already holds, not re-fetched) — this
   * is the documented escape hatch for a future caller that does need
   * a genuine refresh, not a currently-wired code path.
   */
  function invalidatePurchases() {
    purchasesPromise = null;
  }
  function invalidateProgress() {
    progressPromise = null;
  }

  window.LibraryData = { getPurchases, getProgress, invalidatePurchases, invalidateProgress };
})();
