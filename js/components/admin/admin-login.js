/**
 * Robayer WealthLab — Admin Login Component
 *
 * Drives admin/login/index.html specifically (not a shared shell
 * script — this page has no sidebar/topbar, since a signed-out visitor
 * has nothing authenticated to navigate). Two responsibilities: bounce
 * an already-authenticated visitor straight past the form (Phase 0.2's
 * "logged-in users cannot visit login again" requirement), and handle
 * the real submit.
 */

function initAdminLogin() {
  const form = document.querySelector('[data-admin-login-form]');
  if (!form || form.hasAttribute('data-bound')) return;
  form.setAttribute('data-bound', 'true');

  window.AdminAuth.redirectIfAuthenticated();

  const emailInput = form.querySelector('#admin-login-email');
  const passwordInput = form.querySelector('#admin-login-password');
  const submitButton = form.querySelector('[type="submit"]');
  const errorEl = form.querySelector('[data-admin-login-error]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Enter your email and password.');
      return;
    }

    submitButton.disabled = true;
    const defaultLabel = submitButton.textContent;
    submitButton.textContent = 'Signing in…';

    try {
      await window.AdminAuth.login(email, password);
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      submitButton.textContent = defaultLabel;
      passwordInput.value = '';
      passwordInput.focus();
      return;
    }

    const params = new URLSearchParams(window.location.search);
    window.location.href = window.AdminAuth.sanitizeNextPath(params.get('next'));
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', initAdminLogin);
