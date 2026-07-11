/**
 * Robayer WealthLab — Unsubscribe Status Component
 *
 * Drives newsletter/unsubscribe/index.html. Reads `?token=` from the
 * URL, does a safe read-only GET to check the token before showing
 * anything mutable — an email-client link scanner/prefetcher hitting
 * this page automatically must never unsubscribe anyone by itself,
 * only a real, explicit click on the confirm button does that (a POST).
 * Same reasoning as buy-button.js/fulfilment-status.js: never trust or
 * render anything beyond what the API returns, fail honestly and
 * retryably on a network error rather than silently.
 */

const UNSUBSCRIBE_API_BASE = 'https://robayer-wealthlab-api.robayerwealthlab.workers.dev';

function initUnsubscribeStatus() {
  const root = document.querySelector('[data-unsubscribe-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = root.querySelector('[data-unsubscribe-loading]');
  const confirmEl = root.querySelector('[data-unsubscribe-confirm]');
  const confirmButton = root.querySelector('[data-unsubscribe-confirm-button]');
  const confirmErrorEl = root.querySelector('[data-unsubscribe-confirm-error]');
  const emailEl = root.querySelector('[data-unsubscribe-email]');
  const successEl = root.querySelector('[data-unsubscribe-success]');
  const successEmailEl = root.querySelector('[data-unsubscribe-success-email]');
  const invalidEl = root.querySelector('[data-unsubscribe-invalid]');
  const invalidMessageEl = root.querySelector('[data-unsubscribe-invalid-message]');

  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    showInvalid("This unsubscribe link is missing its token — it may have been copied incorrectly.");
    return;
  }

  checkStatus();

  async function checkStatus() {
    let result;
    try {
      result = await fetchJson(`${UNSUBSCRIBE_API_BASE}/api/newsletter/unsubscribe/${encodeURIComponent(token)}`, 'GET');
    } catch (error) {
      showInvalid(error.message);
      return;
    }

    if (result.alreadyUnsubscribed) {
      showSuccess(result.email);
      return;
    }

    showConfirm(result.email);
  }

  function showConfirm(email) {
    loadingEl.hidden = true;
    invalidEl.hidden = true;
    confirmEl.hidden = false;
    emailEl.textContent = email;

    confirmButton.addEventListener('click', onConfirmClick, { once: true });
  }

  async function onConfirmClick() {
    clearConfirmError();
    const defaultLabel = confirmButton.textContent;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Unsubscribing…';

    let result;
    try {
      result = await fetchJson(`${UNSUBSCRIBE_API_BASE}/api/newsletter/unsubscribe/${encodeURIComponent(token)}`, 'POST');
    } catch (error) {
      showConfirmError(error.message);
      confirmButton.disabled = false;
      confirmButton.textContent = defaultLabel;
      // Allow retrying — re-bind for a second attempt.
      confirmButton.addEventListener('click', onConfirmClick, { once: true });
      return;
    }

    showSuccess(result.email);
  }

  function showSuccess(email) {
    loadingEl.hidden = true;
    confirmEl.hidden = true;
    invalidEl.hidden = true;
    successEl.hidden = false;
    successEmailEl.textContent = email;
  }

  function showInvalid(message) {
    loadingEl.hidden = true;
    confirmEl.hidden = true;
    successEl.hidden = true;
    invalidEl.hidden = false;
    if (message) invalidMessageEl.textContent = message;
  }

  function showConfirmError(message) {
    confirmErrorEl.textContent = message;
    confirmErrorEl.hidden = false;
  }

  function clearConfirmError() {
    confirmErrorEl.hidden = true;
    confirmErrorEl.textContent = '';
  }

  async function fetchJson(url, method) {
    let response;
    try {
      response = await fetch(url, { method });
    } catch {
      throw new Error('Could not reach the server. Please check your connection and try again.');
    }
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
    }
    return body.data;
  }
}

document.addEventListener('partials:loaded', initUnsubscribeStatus);
document.addEventListener('DOMContentLoaded', initUnsubscribeStatus);
