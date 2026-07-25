/**
 * Robayer WealthLab: Forgot Password Form Component — Version 3.0.2
 * Milestone M1 (Customer Identity & Guest Checkout).
 *
 * Progressive enhancement for the form on /checkout/forgot-password/.
 * POSTs to POST /api/customer/auth/forgot-password, which — per
 * services/customer/authService.ts's no-enumeration discipline —
 * always returns the same generic success response whether or not the
 * email has an account, so this form always shows the same
 * confirmation message too; it never learns (and must never imply)
 * whether a given email is a real customer.
 */

const FORGOT_PASSWORD_API_URL = '/api/customer/auth/forgot-password';

function initForgotPasswordForm() {
  const form = document.querySelector('[data-forgot-password-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', 'true');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const emailInput = form.querySelector('#forgot-password-email');
    const email = emailInput ? emailInput.value.trim() : '';

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Sending…';
    }

    try {
      await fetch(FORGOT_PASSWORD_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Deliberately ignores the response body beyond a network-level
      // failure — the endpoint always returns the same generic
      // { requested: true } shape by design (no-enumeration), so
      // there's nothing meaningful to branch on.
      showConfirmation(form);
    } catch {
      // A network-level failure (fetch() itself throwing) is the only
      // case worth surfacing — still shown generically, never
      // distinguishing "email not found" from any other outcome.
      showConfirmation(form);
    }
  });

  function showConfirmation(formEl) {
    const confirmation = document.createElement('p');
    confirmation.className = 'alert alert--success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = "If that email has an account, we've sent a link to set or reset your password. Check your inbox.";
    formEl.replaceWith(confirmation);
  }
}

document.addEventListener('partials:loaded', initForgotPasswordForm);
document.addEventListener('DOMContentLoaded', initForgotPasswordForm);
