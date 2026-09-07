/**
 * Robayer WealthLab: Email Verification Landing Page — Affiliate
 * Programme 2.0 (Free Registration). Reads the `?token=` query param
 * set by the link in the customer-email-verification email
 * (services/customer/authService.ts's issueEmailVerificationToken()),
 * calls GET /api/customer/auth/verify-email, and shows success/failure
 * in place. No session required — the token is its own bearer
 * credential, same pattern as set-password-form.js's flow.
 */

const VERIFY_EMAIL_API_URL = '/api/customer/auth/verify-email';

function initVerifyEmail() {
  const pendingEl = document.querySelector('[data-verify-email-pending]');
  const successEl = document.querySelector('[data-verify-email-success]');
  const failureEl = document.querySelector('[data-verify-email-failure]');
  if (!pendingEl || pendingEl.hasAttribute('data-bound')) return;
  pendingEl.setAttribute('data-bound', 'true');

  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    showFailure();
    return;
  }

  fetch(`${VERIFY_EMAIL_API_URL}?token=${encodeURIComponent(token)}`)
    .then((response) => response.json().then((result) => ({ ok: response.ok, result })))
    .then(({ ok, result }) => {
      if (ok && result && result.success) {
        showSuccess();
      } else {
        showFailure();
      }
    })
    .catch(() => showFailure());

  function showSuccess() {
    pendingEl.hidden = true;
    if (successEl) successEl.hidden = false;
  }

  function showFailure() {
    pendingEl.hidden = true;
    if (failureEl) failureEl.hidden = false;
  }
}

document.addEventListener('partials:loaded', initVerifyEmail);
document.addEventListener('DOMContentLoaded', initVerifyEmail);
