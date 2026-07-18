/**
 * Robayer WealthLab — Accept Invitation Component, Version 2.1 Phase 4
 * (User Management). Drives admin/accept-invite/index.html — the page
 * linked from the invite email, reading its single-use token from
 * `?token=`. Public/unauthenticated, matching
 * admin-reset-password.js's exact pattern.
 */

function initAdminAcceptInvite() {
  const form = document.querySelector('[data-invite-accept-form]');
  if (!form || form.hasAttribute('data-bound')) return;
  form.setAttribute('data-bound', 'true');

  const token = new URLSearchParams(window.location.search).get('token');
  const titleEl = document.querySelector('[data-invite-title]');
  const summaryEl = document.querySelector('[data-invite-summary]');
  const errorEl = document.querySelector('[data-invite-error]');
  const successEl = document.querySelector('[data-invite-success]');
  const passwordInput = form.querySelector('#invite-accept-password');
  const confirmInput = form.querySelector('#invite-accept-password-confirm');
  const submitButton = form.querySelector('button[type="submit"]');

  if (!token) {
    showError('This invitation link is missing its token.');
    form.hidden = true;
    return;
  }

  validateToken();

  async function validateToken() {
    try {
      const invite = await window.AdminAuth.adminFetch(`/api/admin/auth/accept-invite?token=${encodeURIComponent(token)}`);
      const roleLabel = invite.role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      summaryEl.textContent = `${invite.email} — invited as ${roleLabel}.`;
      summaryEl.hidden = false;
    } catch (error) {
      showError(error.message || 'This invitation is invalid or has expired.');
      form.hidden = true;
    }
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
      await window.AdminAuth.adminFetch('/api/admin/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: passwordInput.value }),
      });
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      return;
    }

    titleEl.textContent = 'Welcome aboard';
    form.hidden = true;
    summaryEl.hidden = true;
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

document.addEventListener('DOMContentLoaded', initAdminAcceptInvite);
