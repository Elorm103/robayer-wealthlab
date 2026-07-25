/**
 * Robayer WealthLab: Set Password Form Component — Version 3.0.2
 * Milestone M1 (Customer Identity & Guest Checkout).
 *
 * Progressive enhancement for the form on /checkout/set-password/.
 * Reads the single-use token from the URL's ?token= query param,
 * validates a new password client-side (basic length check only —
 * the real strength policy is enforced server-side by
 * utils/passwordPolicy.ts, same "never trust client-side validation
 * alone" discipline as every other form on this site), then POSTs to
 * POST /api/customer/auth/set-password. Same progressive-enhancement,
 * honest-failure pattern as js/components/newsletter-form.js and
 * js/components/buy-button.js: a network failure, an expired/invalid
 * token, or a validation error all show a friendly, retryable message
 * in place, never a dead end.
 *
 * Serves both the initial post-purchase password setup (token from
 * the welcome email) and a later self-service reset (token from
 * forgot-password) — the form and this script don't need to know
 * which one a given visit is; the token alone determines that
 * server-side.
 */

const SET_PASSWORD_API_URL = '/api/customer/auth/set-password';
const MIN_PASSWORD_LENGTH = 12; // mirrors utils/passwordPolicy.ts's MIN_LENGTH — a client-side hint only, never the actual enforcement

function initSetPasswordForm() {
  const form = document.querySelector('[data-set-password-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', 'true');

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const tokenMissingEl = document.querySelector('[data-set-password-no-token]');

  if (!token) {
    form.hidden = true;
    if (tokenMissingEl) tokenMissingEl.hidden = false;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const passwordInput = form.querySelector('#new-password');
    const confirmInput = form.querySelector('#confirm-password');
    const errorEl = form.querySelector('.field__error');
    const password = passwordInput ? passwordInput.value : '';
    const confirm = confirmInput ? confirmInput.value : '';

    let clientError = '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      clientError = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password !== confirm) {
      clientError = 'Passwords do not match.';
    }

    if (clientError) {
      form.classList.add('field--error');
      if (errorEl) {
        errorEl.textContent = clientError;
        errorEl.hidden = false;
      }
      (confirmInput || passwordInput).focus();
      return;
    }

    form.classList.remove('field--error');
    if (errorEl) errorEl.hidden = true;
    clearServerError(form);

    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Setting password…';
    }

    try {
      const response = await fetch(SET_PASSWORD_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
      }

      showConfirmation(form);
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Could not reach the server. Please check your connection and try again.'
        : error.message;
      showServerError(form, message);
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Set password';
      }
    }
  });

  function showConfirmation(formEl) {
    const confirmation = document.createElement('div');
    confirmation.setAttribute('role', 'status');
    confirmation.innerHTML =
      '<p class="alert alert--success mb-4">Your password is set. You can now sign in anytime to see your purchases.</p>' +
      '<a href="/checkout/sign-in/" class="btn btn--accent">Sign in</a>';
    formEl.replaceWith(confirmation);
  }

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

document.addEventListener('partials:loaded', initSetPasswordForm);
document.addEventListener('DOMContentLoaded', initSetPasswordForm);
