/**
 * Robayer WealthLab — User Management list page, Version 2.1 Phase 4.
 * Drives admin/users/index.html: the admin roster, pending invitations,
 * and the invite flow. Row-level actions (disable/reactivate/delete)
 * live here; the full detail view (role edit, sessions, login history,
 * force-* security actions) lives on admin/users/detail/?id=.
 *
 * Runs after admin-shell.js's `requireSession()` gate, matching every
 * other admin module script. Every mutation below hits a
 * `super_admin`-only endpoint — a non-super_admin never reaches this
 * page's data at all (the initial `loadAdmins()` call itself would
 * fail with `FORBIDDEN`), but the server enforces this regardless of
 * what this script does.
 */

const USERS_API_BASE = '/api/admin/users';

function initAdminUsers() {
  const root = document.querySelector('[data-users-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = { showDeleted: false };

  const els = {
    loadError: root.querySelector('[data-users-load-error]'),
    success: root.querySelector('[data-users-success]'),
    resultCount: root.querySelector('[data-users-result-count]'),
    empty: root.querySelector('[data-users-empty]'),
    tableWrap: root.querySelector('[data-users-table-wrap]'),
    tableBody: root.querySelector('[data-users-table-body]'),
    invitesCard: root.querySelector('[data-users-invites-card]'),
    invitesBody: root.querySelector('[data-invites-table-body]'),
  };

  const inviteModal = document.querySelector('[data-invite-modal]');
  const inviteForm = document.querySelector('[data-invite-form]');
  const inviteError = document.querySelector('[data-invite-error]');
  const confirmModal = document.querySelector('[data-confirm-modal]');

  bindStatusFilters();
  bindInviteModal();
  bindModalShells();
  loadAdmins();

  function bindStatusFilters() {
    root.querySelectorAll('[data-users-status-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.showDeleted = chip.getAttribute('data-users-status-filter') === 'deleted';
        root.querySelectorAll('[data-users-status-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        els.invitesCard.hidden = state.showDeleted;
        loadAdmins();
      });
    });
  }

  async function loadAdmins() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      if (state.showDeleted) params.set('deleted', 'true');
      const result = await window.AdminAuth.adminFetch(`${USERS_API_BASE}?${params.toString()}`);
      renderAdmins(result.admins);
      renderInvites(state.showDeleted ? [] : result.pendingInvites);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load administrators.';
      els.loadError.hidden = false;
    }
  }

  function renderAdmins(admins) {
    els.resultCount.textContent = `${admins.length} administrator${admins.length === 1 ? '' : 's'}`;
    els.tableBody.innerHTML = '';

    if (admins.length === 0) {
      els.empty.hidden = false;
      els.tableWrap.hidden = true;
      return;
    }
    els.empty.hidden = true;
    els.tableWrap.hidden = false;

    admins.forEach((admin) => els.tableBody.appendChild(buildAdminRow(admin)));
  }

  function buildAdminRow(admin) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const nameLink = document.createElement('a');
    nameLink.href = `/admin/users/detail/?id=${admin.id}`;
    nameLink.innerHTML = `<strong>${escapeHtml(admin.name || admin.email)}</strong>`;
    nameCell.appendChild(nameLink);
    if (admin.name) {
      const emailLine = document.createElement('div');
      emailLine.className = 'text-small text-secondary';
      emailLine.textContent = admin.email;
      nameCell.appendChild(emailLine);
    }

    const roleCell = document.createElement('td');
    roleCell.textContent = admin.roleLabel;

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(admin));

    const securityCell = document.createElement('td');
    securityCell.appendChild(securityBadge(admin));

    const lastLoginCell = document.createElement('td');
    lastLoginCell.textContent = admin.lastLoginAt ? formatDate(admin.lastLoginAt) : 'Never';

    const sessionsCell = document.createElement('td');
    sessionsCell.textContent = String(admin.activeSessionCount);

    const createdByCell = document.createElement('td');
    createdByCell.textContent = admin.createdByName || '—';

    const actionsCell = document.createElement('td');
    actionsCell.appendChild(buildRowActions(admin));

    row.append(nameCell, roleCell, statusCell, securityCell, lastLoginCell, sessionsCell, createdByCell, actionsCell);
    return row;
  }

  function statusBadge(admin) {
    const span = document.createElement('span');
    if (admin.deletedAt) {
      span.className = 'badge badge--error';
      span.textContent = 'Deleted';
    } else if (!admin.isActive) {
      span.className = 'badge badge--warning';
      span.textContent = 'Disabled';
    } else {
      span.className = 'badge badge--success';
      span.textContent = 'Active';
    }
    return span;
  }

  function securityBadge(admin) {
    const span = document.createElement('span');
    const isLocked = admin.lockedUntil && new Date(admin.lockedUntil) > new Date();
    if (isLocked) {
      span.className = 'badge badge--error';
      span.textContent = 'Locked';
    } else if (admin.mustChangePassword) {
      span.className = 'badge badge--warning';
      span.textContent = 'Must change password';
    } else {
      span.className = 'badge badge--info';
      span.textContent = 'OK';
    }
    return span;
  }

  function buildRowActions(admin) {
    const wrap = document.createElement('div');
    wrap.className = 'cluster gap-2';

    const viewLink = document.createElement('a');
    viewLink.href = `/admin/users/detail/?id=${admin.id}`;
    viewLink.className = 'btn btn--secondary';
    viewLink.textContent = 'Manage';
    wrap.appendChild(viewLink);

    if (admin.deletedAt) return wrap;

    if (admin.isActive) {
      const disableButton = document.createElement('button');
      disableButton.type = 'button';
      disableButton.className = 'btn btn--secondary';
      disableButton.textContent = 'Disable';
      disableButton.addEventListener('click', () =>
        openConfirm('Disable this administrator?', `${admin.name || admin.email} will immediately lose access and be signed out everywhere.`, async () => {
          await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${admin.id}/disable`, { method: 'POST' });
          showSuccess('Administrator disabled.');
          loadAdmins();
        })
      );
      wrap.appendChild(disableButton);
    } else {
      const reactivateButton = document.createElement('button');
      reactivateButton.type = 'button';
      reactivateButton.className = 'btn btn--secondary';
      reactivateButton.textContent = 'Reactivate';
      reactivateButton.addEventListener('click', async () => {
        try {
          await window.AdminAuth.adminFetch(`${USERS_API_BASE}/${admin.id}/reactivate`, { method: 'POST' });
          showSuccess('Administrator reactivated.');
          loadAdmins();
        } catch (error) {
          showLoadError(error.message);
        }
      });
      wrap.appendChild(reactivateButton);
    }

    return wrap;
  }

  function renderInvites(invites) {
    els.invitesCard.hidden = invites.length === 0;
    els.invitesBody.innerHTML = '';
    invites.forEach((invite) => {
      const row = document.createElement('tr');

      const emailCell = document.createElement('td');
      emailCell.textContent = invite.name ? `${invite.name} <${invite.email}>` : invite.email;

      const roleCell = document.createElement('td');
      roleCell.textContent = invite.roleLabel;

      const invitedByCell = document.createElement('td');
      invitedByCell.textContent = invite.invitedByName || '—';

      const expiresCell = document.createElement('td');
      expiresCell.textContent = formatDate(invite.expiresAt);

      const actionsCell = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'cluster gap-2';

      const resendButton = document.createElement('button');
      resendButton.type = 'button';
      resendButton.className = 'btn btn--secondary';
      resendButton.textContent = 'Resend';
      resendButton.addEventListener('click', async () => {
        try {
          await window.AdminAuth.adminFetch(`${USERS_API_BASE}/invites/${invite.id}/resend`, { method: 'POST' });
          showSuccess('Invitation resent.');
          loadAdmins();
        } catch (error) {
          showLoadError(error.message);
        }
      });

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'btn btn--accent';
      cancelButton.textContent = 'Cancel';
      cancelButton.addEventListener('click', () =>
        openConfirm('Cancel this invitation?', `The invitation to ${invite.email} will no longer work.`, async () => {
          await window.AdminAuth.adminFetch(`${USERS_API_BASE}/invites/${invite.id}`, { method: 'DELETE' });
          showSuccess('Invitation cancelled.');
          loadAdmins();
        })
      );

      wrap.append(resendButton, cancelButton);
      actionsCell.appendChild(wrap);
      row.append(emailCell, roleCell, invitedByCell, expiresCell, actionsCell);
      els.invitesBody.appendChild(row);
    });
  }

  // ============================================================
  // Invite modal
  // ============================================================

  function bindInviteModal() {
    root.querySelector('[data-users-invite-open]').addEventListener('click', () => {
      inviteForm.reset();
      inviteError.hidden = true;
      openModal(inviteModal);
    });

    inviteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      inviteError.hidden = true;

      const email = inviteForm.querySelector('#invite-email').value.trim();
      const name = inviteForm.querySelector('#invite-name').value.trim();
      const role = inviteForm.querySelector('#invite-role').value;

      const submitButton = inviteForm.querySelector('button[type="submit"]');
      submitButton.disabled = true;

      try {
        await window.AdminAuth.adminFetch(`${USERS_API_BASE}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name: name || null, role }),
        });
        closeModal(inviteModal);
        showSuccess(`Invitation sent to ${email}.`);
        loadAdmins();
      } catch (error) {
        inviteError.textContent = error.message || 'Could not send this invitation.';
        inviteError.hidden = false;
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  // ============================================================
  // Generic confirm modal (disable / reactivate-on-error / cancel-invite)
  // ============================================================

  let pendingConfirmAction = null;

  function openConfirm(title, body, onConfirm) {
    confirmModal.querySelector('[data-confirm-title]').textContent = title;
    confirmModal.querySelector('[data-confirm-body]').textContent = body;
    pendingConfirmAction = onConfirm;
    openModal(confirmModal);
  }

  confirmModal.querySelector('[data-confirm-action]').addEventListener('click', async () => {
    if (!pendingConfirmAction) return;
    const button = confirmModal.querySelector('[data-confirm-action]');
    button.disabled = true;
    try {
      await pendingConfirmAction();
      closeModal(confirmModal);
    } catch (error) {
      showLoadError(error.message || 'This action could not be completed.');
      closeModal(confirmModal);
    } finally {
      button.disabled = false;
      pendingConfirmAction = null;
    }
  });

  // ============================================================
  // Helpers
  // ============================================================

  function showSuccess(message) {
    els.success.textContent = message;
    els.success.hidden = false;
    window.setTimeout(() => (els.success.hidden = true), 4000);
  }

  function showLoadError(message) {
    els.loadError.textContent = message;
    els.loadError.hidden = false;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function formatDate(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function bindModalShells() {
    [inviteModal, confirmModal].forEach((modal) => {
      modal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(modal)));
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!inviteModal.hidden) closeModal(inviteModal);
      if (!confirmModal.hidden) closeModal(confirmModal);
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

document.addEventListener('partials:loaded', initAdminUsers);
