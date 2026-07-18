/**
 * Robayer WealthLab — Reset Password Component, Version 2.1 Phase 3
 * (Identity & Security). Drives admin/reset-password/index.html — the
 * page linked from the password-reset email, reading its single-use
 * token from `?token=`.
 */

function initAdminResetPassword() {
  const form = document.querySelector('[data-admin-reset-form]');
  if (!form || form.hasAttribute('data-bound')) return;
  form.setAttribute('data-bound', 'true');

  const token = new URLSearchParams(window.location.search).get('token');
  const errorEl = form.querySelector('[data-admin-reset-error]');
  const successEl = form.querySelector('[data-admin-reset-success]');
  const passwordInput = form.querySelector('#admin-reset-password');
  const confirmInput = form.querySelector('#admin-reset-password-confirm');
  const submitButton = form.querySelector('button[type="submit"]');

  if (!token) {
    showError('This reset link is missing its token. Please request a new one from the forgot-password page.');
    submitButton.disabled = true;
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    if (passwordInput.value !== confirmInput.value) {
      showError('Passwords do not match.');
      return;
    }

    submitButton.disabled = true;
    try {
      await window.AdminAuth.adminFetch('/api/admin/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: passwordInput.value }),
      });
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      return;
    }

    form.hidden = true;
    successEl.hidden = false;
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

document.addEventListener('DOMContentLoaded', initAdminResetPassword);
