/**
 * Robayer WealthLab: Fulfilment Status Component (Version 1.2 Sprint
 * 2.5, Digital Fulfilment Platform)
 *
 * Drives checkout/callback/index.html, the page a visitor lands on
 * after Paystack redirects them back. Reads `?ref=` from the URL,
 * polls the Worker's fulfilment-status endpoint (payment verification
 * is webhook-driven and asynchronous, so this page cannot assume the
 * purchase is already verified the instant it loads, only that it
 * will be within a few seconds in the normal case), and renders one
 * of three states: processing, ready (with Download buttons), or
 * unavailable.
 *
 * Never renders anything from `purchase_sessions`'s internal status
 * vocabulary or any database id: only the safe, already-mapped
 * fields the API returns (see docs/digital-fulfilment.md's
 * "Security"). Clicking Download re-requests a *fresh* single-use
 * link at that exact moment (never a link embedded ahead of time),
 * matching docs/storage-strategy.md's "the email never contains a
 * permanent link, only a link to request one"; this page follows the
 * identical rule for the same reason.
 */

// Relative: see js/components/newsletter-form.js's equivalent constant.
const FULFILMENT_API_BASE = '';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 10; // ~30 seconds: long enough for normal webhook latency, short enough not to spin forever

function initFulfilmentStatus() {
  const root = document.querySelector('[data-fulfilment-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const processingEl = root.querySelector('[data-fulfilment-processing]');
  const readyEl = root.querySelector('[data-fulfilment-ready]');
  const unavailableEl = root.querySelector('[data-fulfilment-unavailable]');
  const unavailableMessageEl = root.querySelector('[data-fulfilment-unavailable-message]');
  const productEl = root.querySelector('[data-fulfilment-product]');
  const referenceEl = root.querySelector('[data-fulfilment-reference]');
  const downloadsEl = root.querySelector('[data-fulfilment-downloads]');
  const downloadErrorEl = root.querySelector('[data-fulfilment-download-error]');

  const reference = new URLSearchParams(window.location.search).get('ref');
  if (!reference) {
    showUnavailable("We couldn't find a purchase reference in this link.");
    return;
  }

  poll(1);

  async function poll(attempt) {
    let result;
    try {
      result = await fetchStatus(reference);
    } catch {
      // Network/CORS failure: retry the same way a "processing" state
      // would, rather than immediately giving up on a transient blip.
      scheduleNextPoll(attempt);
      return;
    }

    if (!result) {
      showUnavailable('This purchase could not be found. Please check the link or contact support.');
      return;
    }

    if (result.status === 'ready') {
      showReady(result);
      return;
    }

    if (result.status === 'unavailable') {
      showUnavailable();
      return;
    }

    // 'processing'
    scheduleNextPoll(attempt);
  }

  function scheduleNextPoll(attempt) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      showUnavailable(
        "This is taking longer than usual. Your payment may still be processing. Check your email for your receipt, or contact support with your purchase reference."
      );
      return;
    }
    window.setTimeout(() => poll(attempt + 1), POLL_INTERVAL_MS);
  }

  async function fetchStatus(ref) {
    const response = await fetch(`${FULFILMENT_API_BASE}/api/purchases/${encodeURIComponent(ref)}`);
    const body = await response.json();
    if (!response.ok || !body.success) {
      if (body && body.error && body.error.code === 'PURCHASE_NOT_FOUND') return null;
      throw new Error((body && body.error && body.error.message) || 'Unknown error');
    }
    return body.data;
  }

  function showReady(status) {
    processingEl.hidden = true;
    unavailableEl.hidden = true;
    readyEl.hidden = false;

    productEl.textContent = `${status.productTitle} (${status.amountDisplay})`;
    referenceEl.textContent = status.purchaseReference;

    downloadsEl.innerHTML = '';
    status.assets.forEach((asset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--accent';
      button.textContent = `Download ${asset.displayName}`;
      button.addEventListener('click', () => requestDownload(reference, asset.assetId, button));
      downloadsEl.appendChild(button);
    });

    if (status.assets.length === 0) {
      const notice = document.createElement('p');
      notice.className = 'text-secondary';
      notice.textContent = 'Your download is being prepared. Check back shortly or contact support.';
      downloadsEl.appendChild(notice);
    }
  }

  function showUnavailable(message) {
    processingEl.hidden = true;
    readyEl.hidden = true;
    unavailableEl.hidden = false;
    if (message) unavailableMessageEl.textContent = message;
  }

  async function requestDownload(ref, assetId, button) {
    clearDownloadError();
    const defaultLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing…';

    try {
      const response = await fetch(`${FULFILMENT_API_BASE}/api/purchases/${encodeURIComponent(ref)}/downloads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      const body = await response.json();

      if (!response.ok || !body.success || !body.data || !body.data.downloadUrl) {
        throw new Error((body && body.error && body.error.message) || 'This download is not available right now.');
      }

      // A direct navigation, not fetch+blob: GET /api/download/:token's
      // successful response *is* the file (Content-Disposition:
      // attachment); the browser handles the actual file save.
      window.location.href = `${FULFILMENT_API_BASE}${body.data.downloadUrl}`;
      button.textContent = defaultLabel;
      button.disabled = false;
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Could not reach the server. Please check your connection and try again.'
        : error.message;
      showDownloadError(message);
      button.textContent = defaultLabel;
      button.disabled = false;
    }
  }

  function showDownloadError(message) {
    downloadErrorEl.textContent = message;
    downloadErrorEl.hidden = false;
  }

  function clearDownloadError() {
    downloadErrorEl.hidden = true;
    downloadErrorEl.textContent = '';
  }
}

document.addEventListener('partials:loaded', initFulfilmentStatus);
document.addEventListener('DOMContentLoaded', initFulfilmentStatus);
