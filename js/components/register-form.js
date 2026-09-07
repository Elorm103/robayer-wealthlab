/**
 * Robayer WealthLab: Registration Form Component — Affiliate Programme
 * 2.0 (Free Registration).
 *
 * Progressive enhancement for the form on /checkout/register/. POSTs to
 * POST /api/customer/auth/register, which creates the account AND signs
 * it in immediately (sets customer_session/customer_csrf cookies on
 * success, same as sign-in-form.js) — a verification email is also
 * sent, but verifying it is not a gate on using the account. A
 * `?redirect=` param is honored exactly like sign-in-form.js's own
 * sanitizeRedirectPath(), so a visitor who arrived here from the
 * Affiliate Programme's guest CTA lands back on /affiliate/ afterward.
 *
 * Same progressive-enhancement, honest-failure pattern as every other
 * form on this site (js/components/sign-in-form.js,
 * js/components/set-password-form.js).
 */

const REGISTER_API_URL = '/api/customer/auth/register';
const REGISTER_DEFAULT_REDIRECT_PATH = '/affiliate/';
const REGISTER_MIN_PASSWORD_LENGTH = 12; // mirrors utils/passwordPolicy.ts's MIN_LENGTH — a client-side hint only, never the actual enforcement

/** Same open-redirect discipline as sign-in-form.js's sanitizeRedirectPath() — only a literal same-origin path is ever honored. */
function sanitizeRegisterRedirectPath(rawRedirect) {
  if (typeof rawRedirect === 'string' && /^\/(?!\/)/.test(rawRedirect)) {
    return rawRedirect;
  }
  return REGISTER_DEFAULT_REDIRECT_PATH;
}

function initRegisterForm() {
  const form = document.querySelector('[data-register-form]:not([data-bound])');
  if (!form) return;
  form.setAttribute('data-bound', 'true');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const nameInput = form.querySelector('#register-name');
    const emailInput = form.querySelector('#register-email');
    const passwordInput = form.querySelector('#register-password');
    const confirmInput = form.querySelector('#register-password-confirmation');
    const termsInput = form.querySelector('#register-terms');
    const errorEl = form.querySelector('.field__error');

    const name = nameInput ? nameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    const passwordConfirmation = confirmInput ? confirmInput.value : '';
    const termsAccepted = termsInput ? termsInput.checked : false;

    let clientError = '';
    if (password.length < REGISTER_MIN_PASSWORD_LENGTH) {
      clientError = `Password must be at least ${REGISTER_MIN_PASSWORD_LENGTH} characters.`;
    } else if (password !== passwordConfirmation) {
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
      submitButton.textContent = 'Creating account…';
    }

    try {
      const response = await fetch(REGISTER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, passwordConfirmation, termsAccepted }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        const error = new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
        error.code = result && result.error && result.error.code;
        throw error;
      }

      // Same nav.js cache-invalidation as sign-in-form.js — otherwise the
      // header's "Sign In" link would keep showing stale for its TTL.
      try { sessionStorage.removeItem('robayer_library_link_state'); } catch { /* private browsing / unavailable - next load just re-checks */ }

      const params = new URLSearchParams(window.location.search);
      window.location.href = sanitizeRegisterRedirectPath(params.get('redirect'));
    } catch (error) {
      const message = error instanceof TypeError
        ? 'Could not reach the server. Please check your connection and try again.'
        : error.message;
      showServerError(form, message, error.code === 'DUPLICATE_EMAIL');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = 'Create account';
      }
    }
  });

  function showServerError(formEl, message, showSignInLink) {
    clearServerError(formEl);
    const alertEl = document.createElement('p');
    alertEl.className = 'alert alert--error';
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('data-server-error', 'true');
    alertEl.textContent = message || 'Something went wrong. Please try again in a moment.';
    if (showSignInLink) {
      const link = document.createElement('a');
      link.href = '/checkout/sign-in/';
      link.textContent = ' Sign in instead.';
      alertEl.appendChild(link);
    }
    formEl.insertAdjacentElement('beforebegin', alertEl);
  }

  function clearServerError(formEl) {
    const previous = formEl.previousElementSibling;
    if (previous && previous.matches('[data-server-error]')) {
      previous.remove();
    }
  }
}

document.addEventListener('partials:loaded', initRegisterForm);
document.addEventListener('DOMContentLoaded', initRegisterForm);
