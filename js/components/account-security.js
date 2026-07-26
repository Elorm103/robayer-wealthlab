/**
 * Robayer WealthLab: Account Security Component — Version 3.1
 * Milestone M3 (Checkout Auto-Provisioning & Dashboard MVP). Drives
 * dashboard/security/index.html: profile (read-only), change password,
 * active sessions (view/revoke).
 *
 * Structural mirror of js/components/admin/admin-account.js's own
 * change-password/sessions handling (see that file's header comment) —
 * reused, not reinvented, down to the mixed-date-format fix its own
 * `formatDate()` already discovered and fixed once. One deliberate
 * difference: revoking a session here requires an explicit
 * confirmation step first (`window.confirm()`, this codebase's
 * established "no custom modal library" convention — see
 * admin-account.js's own `alert()` precedent for errors), per AR-009's
 * ratified requirement for this specific customer-facing action (see
 * docs/v3.1-m3-ux-strategy.md's Section 7) — the admin equivalent
 * predates that ratification and was not retrofitted here, since this
 * file's own scope is the customer dashboard only.
 */

function initAccountSecurity() {
  const root = document.querySelector('[data-account-security-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    email: root.querySelector('[data-account-email]'),
    passwordForm: root.querySelector('[data-password-form]'),
    passwordError: root.querySelector('[data-password-error]'),
    passwordSuccess: root.querySelector('[data-password-success]'),
    sessionsLoading: root.querySelector('[data-sessions-loading]'),
    sessionsList: root.querySelector('[data-sessions-list]'),
    sessionsError: root.querySelector('[data-sessions-error]'),
  };

  document.addEventListener('dashboard:ready', (event) => {
    els.email.textContent = event.detail.email;
    loadSessions();
  }, { once: true });

  bindPasswordForm();

  // ============================================================
  // Change password
  // ============================================================

  function bindPasswordForm() {
    els.passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      hidePasswordMessages();

      const currentPassword = els.passwordForm.querySelector('#account-current-password').value;
      const newPassword = els.passwordForm.querySelector('#account-new-password').value;
      const confirmPassword = els.passwordForm.querySelector('#account-new-password-confirm').value;

      if (newPassword !== confirmPassword) {
        showPasswordError('New passwords do not match.');
        return;
      }

      const submitButton = els.passwordForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;

      try {
        await window.CustomerDashboard.customerFetch('/api/customer/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
      } catch (error) {
        showPasswordError(error.message);
        submitButton.disabled = false;
        return;
      }

      submitButton.disabled = false;
      els.passwordForm.reset();
      els.passwordSuccess.hidden = false;
      // Every OTHER session was just revoked server-side — refresh the
      // sessions list so it reflects the new reality immediately,
      // rather than the stale multi-session view it may have shown.
      loadSessions();
    });
  }

  function showPasswordError(message) {
    els.passwordError.textContent = message;
    els.passwordError.hidden = false;
  }

  function hidePasswordMessages() {
    els.passwordError.hidden = true;
    els.passwordError.textContent = '';
    els.passwordSuccess.hidden = true;
  }

  // ============================================================
  // Sessions
  // ============================================================

  async function loadSessions() {
    els.sessionsLoading.hidden = false;
    els.sessionsList.hidden = true;
    els.sessionsError.hidden = true;

    let result;
    try {
      result = await window.CustomerDashboard.customerFetch('/api/customer/sessions');
    } catch (error) {
      els.sessionsLoading.hidden = true;
      els.sessionsError.hidden = false;
      els.sessionsError.textContent = error.message || 'Could not load your sessions.';
      return;
    }

    els.sessionsLoading.hidden = true;
    els.sessionsList.hidden = false;
    renderSessions(result.sessions);
  }

  function renderSessions(sessions) {
    els.sessionsList.innerHTML = '';
    sessions.forEach((session) => els.sessionsList.appendChild(renderSessionRow(session)));
  }

  function renderSessionRow(session) {
    const row = document.createElement('div');
    row.className = 'session-row';

    const meta = document.createElement('div');
    const deviceLine = document.createElement('p');
    deviceLine.className = 'mb-0';
    deviceLine.textContent = summarizeUserAgent(session.userAgent);
    if (session.isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--success';
      badge.style.marginLeft = 'var(--space-2)';
      badge.textContent = 'This device';
      deviceLine.appendChild(badge);
    }
    meta.appendChild(deviceLine);

    const lastSeen = document.createElement('p');
    lastSeen.className = 'text-secondary text-small mb-0';
    lastSeen.textContent = `Last active ${formatDate(session.lastSeenAt)}`;
    meta.appendChild(lastSeen);

    row.appendChild(meta);

    if (!session.isCurrent) {
      const revokeButton = document.createElement('button');
      revokeButton.type = 'button';
      revokeButton.className = 'btn btn--secondary';
      revokeButton.textContent = 'Sign out';
      revokeButton.addEventListener('click', () => revokeSession(session.id, revokeButton));
      row.appendChild(revokeButton);
    }

    return row;
  }

  async function revokeSession(sessionId, button) {
    // AR-009 (docs/v3.1-m3-ux-strategy.md, Section 7): an explicit
    // confirmation step before this specific destructive action, never
    // a direct one-click revoke.
    if (!window.confirm('Sign out this session? That device will need to sign in again.')) return;

    button.disabled = true;
    try {
      await window.CustomerDashboard.customerFetch(`/api/customer/sessions/${sessionId}/revoke`, { method: 'POST' });
      loadSessions();
    } catch (error) {
      alert(error.message || 'Could not sign out that session.'); // eslint-disable-line no-alert -- no toast component exists yet, matches js/components/admin/admin-account.js's own established error-surfacing convention
      button.disabled = false;
    }
  }

  /** Direct mirror of js/components/admin/admin-account.js's own summarizeUserAgent() — same honest, no-fingerprinting-library approach. */
  function summarizeUserAgent(userAgent) {
    if (!userAgent) return 'Unknown device';
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Unknown browser';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown OS';
    return `${browser} on ${os}`;
  }

  /** Normalizes both `datetime('now')` (SQL) and `toISOString()` formats — see js/components/admin/admin-account.js's own header comment for the exact mixed-format issue this avoids re-discovering (customer_sessions.last_seen_at has the identical two-write-path shape as admin_sessions.last_seen_at). */
  function formatDate(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

document.addEventListener('partials:loaded', initAccountSecurity);
document.addEventListener('DOMContentLoaded', initAccountSecurity);
