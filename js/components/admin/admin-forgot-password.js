/**
 * Robayer WealthLab — Forgot Password Component, Version 2.1 Phase 3
 * (Identity & Security). Drives admin/forgot-password/index.html.
 *
 * The backend always returns the identical generic response whether
 * or not the email exists (see authService.ts's forgotPassword()) —
 * this form mirrors that on the client: the same success message
 * every time, form fields hidden after submit either way, never a
 * branch that could reveal account existence.
 */

function initAdminForgotPassword() {
  const form = document.querySelector('[data-admin-forgot-form]');
  if (!form || form.hasAttribute('data-bound')) return;
  form.setAttribute('data-bound', 'true');

  window.AdminAuth.redirectIfAuthenticated();

  const emailInput = form.querySelector('#admin-forgot-email');
  const successEl = form.querySelector('[data-admin-forgot-success]');
  const fieldGroups = form.querySelectorAll('[data-admin-forgot-field-group]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    if (!email) return;

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    try {
      await window.AdminAuth.adminFetch('/api/admin/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Deliberately no error branch shown to the user — see this
      // file's header comment. A network-level failure is rare enough
      // that "show the generic success anyway" is the safer default
      // here (never confirms or denies account existence via a
      // differently-worded error state).
    }

    fieldGroups.forEach((el) => (el.hidden = true));
    successEl.hidden = false;
  });
}

document.addEventListener('DOMContentLoaded', initAdminForgotPassword);
