/**
 * Robayer WealthLab — Account & Security page, Version 2.1 Phase 3
 * (Identity & Security). Drives admin/account/index.html: profile
 * (read-only), change password, active sessions (view/revoke), login
 * history. Runs after admin-shell.js's `requireSession()` gate, like
 * every other admin module script.
 *
 * The one admin page reachable while `must_change_password` is set
 * (see admin-auth.js's `requireSession()` and
 * backend/middleware/requireAuth.ts's `MUST_CHANGE_PASSWORD_ALLOWED_PATHS`)
 * — when that flag is on, this page shows only the profile summary
 * and the change-password form; the sessions/login-history sections
 * are hidden rather than attempted, since those endpoints are
 * server-side blocked until the password is changed.
 */

function initAdminAccount() {
  const root = document.querySelector('[data-account-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    mustChangeBanner: root.querySelector('[data-account-must-change-banner]'),
    name: root.querySelector('[data-account-name]'),
    email: root.querySelector('[data-account-email]'),
    role: root.querySelector('[data-account-role]'),
    sessionsCard: root.querySelector('[data-account-sessions-card]'),
    historyCard: root.querySelector('[data-account-history-card]'),
    sessionsBody: root.querySelector('[data-sessions-table-body]'),
    historyBody: root.querySelector('[data-history-table-body]'),
    passwordForm: root.querySelector('[data-password-form]'),
    passwordError: root.querySelector('[data-password-error]'),
    passwordSuccess: root.querySelector('[data-password-success]'),
  };

  loadAccount();
  bindPasswordForm();

  async function loadAccount() {
    let session;
    try {
      session = await window.AdminAuth.adminFetch('/api/admin/auth/session');
    } catch {
      return; // admin-shell.js's own requireSession() call already handles the redirect case
    }

    els.name.textContent = session.name || '—';
    els.email.textContent = session.email;
    els.role.textContent = labelize(session.role);

    if (session.mustChangePassword) {
      els.mustChangeBanner.hidden = false;
      els.sessionsCard.hidden = true;
      els.historyCard.hidden = true;
      return;
    }

    loadSessions();
    loadHistory();
  }

  function labelize(value) {
    return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

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
        await window.AdminAuth.adminFetch('/api/admin/auth/change-password', {
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

      // A successful change clears must_change_password server-side and
      // revokes every other session — reload so this page's own state
      // (banner, sessions/history visibility) reflects the new reality
      // rather than the stale must-change view it may have rendered.
      window.setTimeout(() => window.location.reload(), 1200);
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
    try {
      const result = await window.AdminAuth.adminFetch('/api/admin/auth/sessions');
      renderSessions(result.sessions);
    } catch {
      els.sessionsBody.innerHTML = '<tr><td colspan="4">Could not load sessions.</td></tr>';
    }
  }

  function renderSessions(sessions) {
    els.sessionsBody.innerHTML = '';
    if (sessions.length === 0) {
      els.sessionsBody.innerHTML = '<tr><td colspan="4">No active sessions.</td></tr>';
      return;
    }

    sessions.forEach((session) => {
      const row = document.createElement('tr');

      const deviceCell = document.createElement('td');
      deviceCell.textContent = summarizeUserAgent(session.userAgent);
      if (session.isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'badge badge--success';
        badge.style.marginLeft = 'var(--space-2)';
        badge.textContent = 'This device';
        deviceCell.appendChild(badge);
      }

      const ipCell = document.createElement('td');
      ipCell.textContent = session.ipCreated || '—';

      const lastSeenCell = document.createElement('td');
      lastSeenCell.textContent = formatDate(session.lastSeenAt);

      const actionsCell = document.createElement('td');
      if (!session.isCurrent) {
        const revokeButton = document.createElement('button');
        revokeButton.type = 'button';
        revokeButton.className = 'btn btn--secondary';
        revokeButton.textContent = 'Sign out';
        revokeButton.addEventListener('click', () => revokeSession(session.id, revokeButton));
        actionsCell.appendChild(revokeButton);
      }

      row.append(deviceCell, ipCell, lastSeenCell, actionsCell);
      els.sessionsBody.appendChild(row);
    });
  }

  async function revokeSession(sessionId, button) {
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`/api/admin/auth/sessions/${sessionId}/revoke`, { method: 'POST' });
      loadSessions();
    } catch (error) {
      alert(error.message || 'Could not sign out that session.'); // eslint-disable-line no-alert -- no toast component exists yet, matches this admin's existing error-surfacing convention
      button.disabled = false;
    }
  }

  /** A rough, honest summary — this codebase stores the raw User-Agent string but has no device-fingerprinting library to parse it precisely; "browser on OS" is good enough for a security review, not a marketing analytics need. */
  function summarizeUserAgent(userAgent) {
    if (!userAgent) return 'Unknown device';
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Unknown browser';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown OS';
    return `${browser} on ${os}`;
  }

  // ============================================================
  // Login history
  // ============================================================

  const OUTCOME_LABELS = {
    success: { label: 'Success', variant: 'badge--success' },
    failed_password: { label: 'Wrong password', variant: 'badge--error' },
    failed_locked: { label: 'Blocked (locked)', variant: 'badge--warning' },
    failed_inactive: { label: 'Inactive account', variant: 'badge--warning' },
  };

  async function loadHistory() {
    try {
      const result = await window.AdminAuth.adminFetch('/api/admin/auth/login-history');
      renderHistory(result.history);
    } catch {
      els.historyBody.innerHTML = '<tr><td colspan="3">Could not load login history.</td></tr>';
    }
  }

  function renderHistory(history) {
    els.historyBody.innerHTML = '';
    if (history.length === 0) {
      els.historyBody.innerHTML = '<tr><td colspan="3">No login history yet.</td></tr>';
      return;
    }

    history.forEach((entry) => {
      const row = document.createElement('tr');

      const outcomeCell = document.createElement('td');
      const outcome = OUTCOME_LABELS[entry.outcome] || { label: entry.outcome, variant: 'badge--info' };
      const badge = document.createElement('span');
      badge.className = `badge ${outcome.variant}`;
      badge.textContent = outcome.label;
      outcomeCell.appendChild(badge);

      const ipCell = document.createElement('td');
      ipCell.textContent = entry.ipAddress || '—';

      const whenCell = document.createElement('td');
      whenCell.textContent = formatDate(entry.createdAt);

      row.append(outcomeCell, ipCell, whenCell);
      els.historyBody.appendChild(row);
    });
  }

  /**
   * `admin_sessions.last_seen_at` is written in two different formats
   * depending on the code path: `datetime('now')` at session creation
   * (SQL, space-separated, no timezone suffix) vs. `new Date().toISOString()`
   * on every subsequent validated request (sessionService.ts's
   * `validateSession()`, already `T`-separated with a `Z` suffix) — a
   * real inconsistency found via this exact page showing "Invalid
   * Date" for the current session's row (the one guaranteed to have
   * gone through the second path). Normalizes both into something
   * `Date` can parse instead of assuming one format.
   */
  function formatDate(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

document.addEventListener('partials:loaded', initAdminAccount);
