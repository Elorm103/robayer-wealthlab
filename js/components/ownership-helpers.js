/**
 * Robayer WealthLab: shared ownership-state helpers (Version 3.5.4:
 * Customer Ownership Experience & Product Page Refinement).
 *
 * Version 3.5.3 built the "does this purchase's download still work"
 * message into js/components/book-purchase-state.js only. Version
 * 3.5.4 needed the exact same message on the Customer Library
 * (js/components/library-list.js) and found the date-formatting logic
 * had also been quietly duplicated between the two files with
 * slightly different normalization handling. Both are pulled out here
 * - not a new ownership check, not a new data model, just the one
 * existing rule (services/entitlementService.ts's real, admin-
 * configurable per-purchase download limit, unchanged this milestone)
 * described once instead of twice.
 */
(function () {
  /** Normalizes both `datetime('now')` (SQL, space-separated, no timezone) and `new Date().toISOString()` (already T/Z) - the same fix js/components/admin/admin-account.js's own header comment documents. */
  function formatOwnedDate(isoString) {
    if (!isoString) return '—';
    try {
      const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
      return new Date(normalized).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return isoString;
    }
  }

  /**
   * The one place this codebase describes "can this asset still be
   * downloaded, and if not, why" in customer-facing language - reads
   * the same downloadsUsed/maxDownloads fields
   * services/fulfilmentService.ts's resolveAssetsWithDeliveryInfo()
   * already returns on every purchase's assets array, never a second
   * entitlement check. The wording matches this milestone's own
   * explicit spec: a clear, specific reason instead of a generic
   * failure, with an honest way to escalate ("contact support")
   * instead of a dead end.
   */
  function describeDownloadState(asset) {
    if (!asset || asset.revoked) {
      return { limitReached: true, message: "This purchase's files are no longer available. If you believe this is an error, please contact support." };
    }
    const limitReached = asset.maxDownloads !== null && asset.downloadsUsed >= asset.maxDownloads;
    if (!limitReached) return { limitReached: false, message: null };
    return {
      limitReached: true,
      message: `You have reached the maximum number of downloads allowed for this purchase (${asset.maxDownloads} of ${asset.maxDownloads}). If you believe this is an error, please contact support.`,
    };
  }

  window.RobayerOwnership = { formatOwnedDate, describeDownloadState };
})();
