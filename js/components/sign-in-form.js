/**
 * Robayer WealthLab: Sign-In Form Component — Version 3.0.2 Milestone
 * M1 (Customer Identity & Guest Checkout).
 *
 * Progressive enhancement for the form on /checkout/sign-in/. POSTs to
 * POST /api/customer/auth/login (sets the customer_session/customer_csrf
 * cookies on success), then redirects to the confirmation page's
 * generic "your account" destination. M1 ships no dashboard to land
 * on yet (that's Milestone M3 — see docs/v3.0.2-sprint-readiness-report.md);
 * a successful sign-in redirects to the homepage with a confirmation
 * message rather than a Library page that doesn't exist yet, an
 * honest reflection of what's actually built in this milestone.
 *
 * Same progressive-enhancement, honest-failure pattern as every other
 * form on this site (js/components/newsletter-form.js,
 * js/components/set-password-form.js).
 */

const LOGIN_API_URL = '/api/customer/auth/login';

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

      window.location.href = '/?signed-in=1';
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
