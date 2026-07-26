/**
 * Robayer WealthLab: Sign-In Form Component — Version 3.0.2 Milestone
 * M1 (Customer Identity & Guest Checkout), updated Version 3.1
 * Milestone M3 (Checkout Auto-Provisioning & Dashboard MVP).
 *
 * Progressive enhancement for the form on /checkout/sign-in/. POSTs to
 * POST /api/customer/auth/login (sets the customer_session/customer_csrf
 * cookies on success), then redirects to the dashboard's My Library
 * page — M3 ships that dashboard, closing the gap this file's own
 * header comment previously flagged ("M1 ships no dashboard to land
 * on yet"). A `?redirect=` param (set by
 * js/components/dashboard-auth.js when it sends an unauthenticated
 * visitor here from a specific /dashboard/* page) is honored if
 * present and safe, so a customer returns to the exact page they were
 * trying to reach rather than always landing on My Library.
 *
 * Same progressive-enhancement, honest-failure pattern as every other
 * form on this site (js/components/newsletter-form.js,
 * js/components/set-password-form.js).
 */

const LOGIN_API_URL = '/api/customer/auth/login';
const DEFAULT_POST_LOGIN_PATH = '/dashboard/';

/**
 * Only a value starting with the literal path `/dashboard/` is ever
 * used as a redirect target — never a scheme, never `//` (which
 * browsers resolve as a full cross-origin URL). Mirrors
 * js/components/admin/admin-auth.js's own `sanitizeNextPath()` exactly,
 * the fix for a real open-redirect (CWE-601) that file's own header
 * comment documents finding — applied here from the start rather than
 * introducing the same class of bug fresh.
 */
function sanitizeRedirectPath(rawRedirect) {
  if (typeof rawRedirect === 'string' && /^\/dashboard\/(?!\/)/.test(rawRedirect)) {
    return rawRedirect;
  }
  return DEFAULT_POST_LOGIN_PATH;
}

function initSignInForm() {
  const form = document.querySelector('[data-sign-in-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', 'true');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const emailInput = form.querySelector('#sign-in-email');
    const passwordInput = form.querySelector('#sign-in-password');
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    clearServerError(form);

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Signing in…';
    }

    try {
      const response = await fetch(LOGIN_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
      }

      const params = new URLSearchParams(window.location.search);
      window.location.href = sanitizeRedirectPath(params.get('redirect'));
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Could not reach the server. Please check your connection and try again.'
        : error.message;
      showServerError(form, message);
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Sign in';
      }
    }
  });

  function showServerError(formEl, message) {
    clearServerError(formEl);
    const alertEl = document.createElement('p');
    alertEl.className = 'alert alert--error';
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('data-server-error', 'true');
    alertEl.textContent = message || 'Something went wrong. Please try again in a moment.';
    formEl.insertAdjacentElement('beforebegin', alertEl);
  }

  function clearServerError(formEl) {
    const previous = formEl.previousElementSibling;
    if (previous && previous.matches('[data-server-error]')) {
      previous.remove();
    }
  }
}

document.addEventListener('partials:loaded', initSignInForm);
document.addEventListener('DOMContentLoaded', initSignInForm);
