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
  // Phase J.0.2 fix — was `form.querySelector(...)`, which only ever
  // finds descendants; both elements are deliberate siblings of <form>
  // in the HTML (see that file's own comment — the success path below
  // hides the whole form at once and needs a sibling, not a descendant,
  // to remain visible). `form.querySelector` returned null for both,
  // silently: not caught anywhere, so clicking "Reset password" threw
  // `TypeError: Cannot set properties of null` inside hideError() before
  // the network request was ever sent — confirmed directly against
  // production (no POST /api/admin/auth/reset-password in the network
  // log for the click that triggered this). document.querySelector()
  // finds them correctly since they're real, present elements on the
  // page, just not inside the form.
  const errorEl = document.querySelector('[data-admin-reset-error]');
  const successEl = document.querySelector('[data-admin-reset-success]');
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

    // Phase J.0.2 — the reported symptom included "no obvious network
    // feedback to the user"; a disabled button alone gave none. A real
    // loading label, restored on any failure, matches the pattern
    // already established elsewhere in this codebase (e.g.
    // library-list.js's "Downloading…").
    const defaultLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Resetting…';
    try {
      await window.AdminAuth.adminFetch('/api/admin/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: passwordInput.value }),
      });
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      submitButton.textContent = defaultLabel;
      return;
    }

    form.hidden = true;
    successEl.hidden = false;
    // Matches the established pattern elsewhere in this codebase (see
    // admin-account.js's own post-success setTimeout) — a brief pause so
    // the success message is actually seen before navigating away, then
    // on to sign-in with the new password. resetPassword() already
    // revoked every existing session server-side, so there is no active
    // session to send the admin to /admin/ instead.
    window.setTimeout(() => {
      window.location.href = '/admin/login/';
    }, 1800);
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
