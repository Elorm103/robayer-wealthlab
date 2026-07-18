/**
 * Robayer WealthLab — Administrator detail/management page, Version
 * 2.1 Phase 4 (User Management). Drives admin/users/detail/?id=.
 *
 * Every mutating button here calls a `super_admin`-only, server-side-
 * enforced endpoint (see routes/admin/users.ts) — self-targeting and
 * last-Super-Admin protection are re-checked server-side regardless of
 * what this script hides. This script additionally hides the entire
 * security-actions/danger-zone sidebar when viewing your OWN account
 * (a UX courtesy matching the server-side rule, not the boundary
 * itself), directing that case to `/admin/account/` instead.
 */

const USERS_API_BASE = '/api/admin/users';

function initAdminUserDetail() {
  const root = document.querySelector('[data-user-detail-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const targetId = parseInt(new URLSearchParams(window.location.search).get('id') || '', 10);

  const els = {
    loadError: root.querySelector('[data-detail-load-error]'),
    success: root.querySelector('[data-detail-success]'),
    name: root.querySelector('[data-detail-name]'),
    email: root.querySelector('[data-detail-email]'),
    createdBy: root.querySelector('[data-detail-created-by]'),
    createdAt: root.querySelector('[data-detail-created-at]'),
    roleSelect: root.querySelector('#detail-role'),
    saveRoleButton: root.querySelector('[data-detail-save-role]'),
    statusBadge: root.querySelector('[data-detail-status-badge]'),
    securityBadge: root.querySelector('[data-detail-security-badge]'),
    sessionsCount: root.querySelector('[data-detail-sessions-count]'),
    failedAttempts: root.querySelector('[data-detail-failed-attempts]'),
    lastLogin: root.querySelector('[data-detail-last-login]'),
    lastActivity: root.querySelector('[data-detail-last-activity]'),
    sessionsCard: root.querySelector('[data-detail-sessions-card]'),
    sessionsBody: root.querySelector('[data-detail-sessions-body]'),
    historyCard: root.querySelector('[data-detail-history-card]'),
    historyBody: root.querySelector('[data-detail-history-body]'),
    actionsCard: root.querySelector('[data-detail-actions-card]'),
    dangerZone: root.querySelector('[data-detail-danger-zone]'),
    forcePasswordReset: root.querySelector('[data-detail-force-password-reset]'),
    forcePasswordChange: root.querySelector('[data-detail-force-password-change]'),
    forceLogout: root.querySelector('[data-detail-force-logout]'),
    unlock: root.querySelector('[data-detail-unlock]'),
    disable: root.querySelector('[data-detail-disable]'),
    reactivate: root.querySelector('[data-detail-reactivate]'),
    delete: root.querySelector('[data-detail-delete]'),
  };

  const confirmModal = document.querySelector('[data-confirm-modal]');
  let pendingConfirmAction = null;
  let viewerAdminId = null;

  if (!Number.isInteger(targetId)) {
    showLoadError('No administrator specified.');
    return;
  }

  bindActions();
  bindModalShell();
  load();

  async function load() {
    try {
      const session = await window.AdminAuth.adminFetch('/api/admin/auth/session');
      viewerAdminId = session.adminId;

      const admin = await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}`);
      render(admin);
    } catch (error) {
      showLoadError(error.message || 'Could not load this administrator.');
    }
  }

  function render(admin) {
    els.name.textContent = admin.name || '—';
    els.email.textContent = admin.email;
    els.createdBy.textContent = admin.createdByName || '—';
    els.createdAt.textContent = formatDate(admin.createdAt);

    populateRoleSelect(admin.role);

    const isSelf = admin.id === viewerAdminId;
    els.actionsCard.hidden = isSelf;
    els.dangerZone.hidden = isSelf;
    els.saveRoleButton.hidden = isSelf;
    els.roleSelect.disabled = isSelf;
    if (isSelf) {
      showLoadError('This is your own account — manage your own role, password, and sessions from My Account.');
    }

    els.statusBadge.className = `badge ${admin.deletedAt ? 'badge--error' : admin.isActive ? 'badge--success' : 'badge--warning'}`;
    els.statusBadge.textContent = admin.deletedAt ? 'Deleted' : admin.isActive ? 'Active' : 'Disabled';

    const isLocked = admin.lockedUntil && new Date(admin.lockedUntil) > new Date();
    els.securityBadge.className = `badge ${isLocked ? 'badge--error' : admin.mustChangePassword ? 'badge--warning' : 'badge--info'}`;
    els.securityBadge.textContent = isLocked ? 'Locked' : admin.mustChangePassword ? 'Must change password' : 'OK';
    els.unlock.hidden = !isLocked;

    els.sessionsCount.textContent = `${admin.activeSessionCount} active session${admin.activeSessionCount === 1 ? '' : 's'}`;
    els.failedAttempts.textContent = `${admin.failedLoginAttempts} failed login attempt${admin.failedLoginAttempts === 1 ? '' : 's'}`;
    els.lastLogin.textContent = admin.lastLoginAt ? `Last login: ${formatDate(admin.lastLoginAt)}` : 'Never logged in';
    els.lastActivity.textContent = admin.lastActivityAt ? `Last activity: ${formatDate(admin.lastActivityAt)}` : 'No recorded activity';

    els.disable.hidden = !admin.isActive;
    els.reactivate.hidden = admin.isActive;

    renderSessions(admin.sessions);
    renderHistory(admin.loginHistory);

    if (admin.deletedAt) {
      els.actionsCard.hidden = true;
      els.dangerZone.hidden = true;
      els.saveRoleButton.hidden = true;
      els.roleSelect.disabled = true;
    }
  }

  function populateRoleSelect(currentRole) {
    els.roleSelect.innerHTML = '';
    [
      ['support', 'Support'],
      ['editor', 'Editor'],
      ['super_admin', 'Super Admin'],
    ].forEach(([value, label]) => els.roleSelect.appendChild(new Option(label, value, false, value === currentRole)));
  }

  function renderSessions(sessions) {
    els.sessionsBody.innerHTML = '';
    if (sessions.length === 0) {
      els.sessionsBody.innerHTML = '<tr><td colspan="3">No active sessions.</td></tr>';
      return;
    }
    sessions.forEach((session) => {
      const row = document.createElement('tr');
      const device = document.createElement('td');
      device.textContent = summarizeUserAgent(session.userAgent);
      const ip = document.createElement('td');
      ip.textContent = session.ipCreated || '—';
      const lastSeen = document.createElement('td');
      lastSeen.textContent = formatDate(session.lastSeenAt);
      row.append(device, ip, lastSeen);
      els.sessionsBody.appendChild(row);
    });
  }

  const OUTCOME_LABELS = {
    success: { label: 'Success', variant: 'badge--success' },
    failed_password: { label: 'Wrong password', variant: 'badge--error' },
    failed_locked: { label: 'Blocked (locked)', variant: 'badge--warning' },
    failed_inactive: { label: 'Inactive account', variant: 'badge--warning' },
  };

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

  function summarizeUserAgent(userAgent) {
    if (!userAgent) return 'Unknown device';
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Unknown browser';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown OS';
    return `${browser} on ${os}`;
  }

  function formatDate(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // ============================================================
  // Actions
  // ============================================================

  function bindActions() {
    els.saveRoleButton.addEventListener('click', async () => {
      const newRole = els.roleSelect.value;
      await runAction(els.saveRoleButton, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        showSuccess('Role updated. Their sessions have been signed out under the new role.');
        load();
      });
    });

    els.forcePasswordReset.addEventListener('click', () =>
      confirmAndRun('Force a password reset?', 'They will receive an email with a link to set a new password. Their current password keeps working until they use it.', els.forcePasswordReset, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/force-password-reset`, { method: 'POST' });
        showSuccess('Password reset email sent.');
      })
    );

    els.forcePasswordChange.addEventListener('click', () =>
      confirmAndRun('Force a password change?', 'They will be required to change their password before using the admin again, starting with their very next request.', els.forcePasswordChange, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/force-password-change`, { method: 'POST' });
        showSuccess('This administrator must now change their password.');
        load();
      })
    );

    els.forceLogout.addEventListener('click', () =>
      confirmAndRun('Force logout everywhere?', 'Every active session on this account will be signed out immediately.', els.forceLogout, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/force-logout`, { method: 'POST' });
        showSuccess('Signed out of every session.');
        load();
      })
    );

    els.unlock.addEventListener('click', () =>
      confirmAndRun('Unlock this account?', 'The failed-login lockout will be cleared immediately.', els.unlock, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/unlock`, { method: 'POST' });
        showSuccess('Account unlocked.');
        load();
      })
    );

    els.disable.addEventListener('click', () =>
      confirmAndRun('Disable this account?', 'They will immediately lose access and be signed out everywhere. This can be reversed.', els.disable, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/disable`, { method: 'POST' });
        showSuccess('Account disabled.');
        load();
      })
    );

    els.reactivate.addEventListener('click', () =>
      confirmAndRun('Reactivate this account?', 'They will be able to sign in again.', els.reactivate, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}/reactivate`, { method: 'POST' });
        showSuccess('Account reactivated.');
        load();
      })
    );

    els.delete.addEventListener('click', () =>
      confirmAndRun('Delete this account?', 'It will be hidden from the admin and be signed out everywhere. It can be restored later — nothing is permanently deleted.', els.delete, async () => {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${targetId}`, { method: 'DELETE' });
        window.location.href = '/admin/users/';
      })
    );
  }

  async function runAction(button, action) {
    button.disabled = true;
    els.loadError.hidden = true;
    try {
      await action();
    } catch (error) {
      showLoadError(error.message || 'This action could not be completed.');
    } finally {
      button.disabled = false;
    }
  }

  function confirmAndRun(title, body, button, action) {
    confirmModal.querySelector('[data-confirm-title]').textContent = title;
    confirmModal.querySelector('[data-confirm-body]').textContent = body;
    pendingConfirmAction = () => runAction(button, action);
    openModal(confirmModal);
  }

  confirmModal.querySelector('[data-confirm-action]').addEventListener('click', async () => {
    if (!pendingConfirmAction) return;
    const action = pendingConfirmAction;
    pendingConfirmAction = null;
    closeModal(confirmModal);
    await action();
  });

  function showSuccess(message) {
    els.success.textContent = message;
    els.success.hidden = false;
    window.setTimeout(() => (els.success.hidden = true), 4000);
  }

  function showLoadError(message) {
    els.loadError.textContent = message;
    els.loadError.hidden = false;
  }

  function bindModalShell() {
    confirmModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(confirmModal)));
    confirmModal.addEventListener('click', (event) => {
      if (event.target === confirmModal) closeModal(confirmModal);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !confirmModal.hidden) closeModal(confirmModal);
    });
  }

  function openModal(modal) {
    modal.returnFocusTo = document.activeElement;
    modal.hidden = false;
    const focusable = modal.querySelector('button, [href], input, select, textarea');
    if (focusable) focusable.focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (modal.returnFocusTo && document.contains(modal.returnFocusTo)) modal.returnFocusTo.focus();
    modal.returnFocusTo = null;
  }
}

document.addEventListener('partials:loaded', initAdminUserDetail);
