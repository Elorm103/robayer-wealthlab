/**
 * Robayer WealthLab — Contact Manager admin page (Version 2.0 Phase 3,
 * Operational Visibility)
 *
 * Near-identical to admin-consultations.js by design (same list/drawer
 * pattern) — the one structural difference is contact_messages has no
 * category field, so there's no category filter/column here.
 */

const CONTACTS_API_BASE = '/api/admin/contacts';

function initAdminContacts() {
  const root = document.querySelector('[data-contacts-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    assignedTo: '',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
    admins: [],
    drawerId: null,
  };

  const els = {
    loadError: root.querySelector('[data-contacts-load-error]'),
    searchInput: root.querySelector('[data-contacts-search]'),
    assigneeSelect: root.querySelector('[data-contacts-assignee]'),
    resultCount: root.querySelector('[data-contacts-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-contacts-status-filter]')),
    emptyState: root.querySelector('[data-contacts-empty]'),
    emptyTitle: root.querySelector('[data-contacts-empty-title]'),
    emptyBody: root.querySelector('[data-contacts-empty-body]'),
    tableWrap: root.querySelector('[data-contacts-table-wrap]'),
    tableBody: root.querySelector('[data-contacts-table-body]'),
    pagination: root.querySelector('[data-contacts-pagination]'),
    paginationLabel: root.querySelector('[data-contacts-pagination-label]'),
    paginationPrev: root.querySelector('[data-contacts-pagination-prev]'),
    paginationNext: root.querySelector('[data-contacts-pagination-next]'),
  };

  const drawer = document.querySelector('[data-contacts-drawer]');
  const drawerEls = {
    name: drawer.querySelector('[data-contact-drawer-name]'),
    meta: drawer.querySelector('[data-contact-drawer-meta]'),
    error: drawer.querySelector('[data-contact-drawer-error]'),
    email: drawer.querySelector('[data-contact-drawer-email]'),
    phoneRow: drawer.querySelector('[data-contact-drawer-phone-row]'),
    phone: drawer.querySelector('[data-contact-drawer-phone]'),
    message: drawer.querySelector('[data-contact-drawer-message]'),
    status: drawer.querySelector('[data-contact-drawer-status]'),
    assignee: drawer.querySelector('[data-contact-drawer-assignee]'),
    notes: drawer.querySelector('[data-contact-drawer-notes]'),
    notesEmpty: drawer.querySelector('[data-contact-drawer-notes-empty]'),
    noteInput: drawer.querySelector('[data-contact-drawer-note-input]'),
    addNoteButton: drawer.querySelector('[data-contact-drawer-add-note]'),
    mailto: drawer.querySelector('[data-contact-drawer-mailto]'),
  };

  loadMeta();
  bindToolbar();
  bindDrawer();
  refresh();

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}/meta`);
      state.admins = meta.admins;
      meta.admins.forEach((admin) => {
        els.assigneeSelect.appendChild(new Option(admin.name || admin.email, String(admin.id)));
        drawerEls.assignee.appendChild(new Option(admin.name || admin.email, String(admin.id)));
      });
    } catch {
      // Filter/drawer assignee dropdowns simply stay at "Unassigned only" if this fails — not fatal to the page.
    }
  }

  function labelize(value) {
    return value.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      if (state.search) params.set('search', state.search);
      if (state.status) params.set('status', state.status);
      if (state.assignedTo === 'unassigned') {
        // No server-side "unassigned" filter — filtered client-side below, same convention as admin-consultations.js.
      } else if (state.assignedTo) {
        params.set('assignedTo', state.assignedTo);
      }
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}?${params.toString()}`);
      state.items = state.assignedTo === 'unassigned' ? result.items.filter((item) => !item.assignedTo) : result.items;
      state.total = state.assignedTo === 'unassigned' ? state.items.length : result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load contact messages.';
      els.loadError.hidden = false;
    }
  }

  function bindToolbar() {
    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.search = els.searchInput.value.trim();
        state.page = 1;
        refresh();
      }, 300);
    });

    els.assigneeSelect.addEventListener('change', () => {
      state.assignedTo = els.assigneeSelect.value;
      state.page = 1;
      refresh();
    });

    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-contacts-status-filter');
        state.page = 1;
        syncChips();
        refresh();
      });
    });

    els.paginationPrev.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        refresh();
      }
    });
    els.paginationNext.addEventListener('click', () => {
      if (state.page * state.pageSize < state.total) {
        state.page += 1;
        refresh();
      }
    });
  }

  function syncChips() {
    els.statusChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-contacts-status-filter') === state.status));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 message' : `${state.total} messages`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (state.search || state.status || state.assignedTo) {
      els.emptyTitle.textContent = 'No contact messages match these filters';
      els.emptyBody.textContent = 'Try a different search or clear the filters above.';
    } else {
      els.emptyTitle.textContent = 'No contact messages yet';
      els.emptyBody.textContent = 'New messages submitted through the public contact form will appear here.';
    }
    if (!hasItems) return;

    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
  }

  function buildRow(item) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => openDrawer(item.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDrawer(item.id);
      }
    });

    const nameCell = document.createElement('td');
    const nameLine = document.createElement('p');
    nameLine.textContent = item.name;
    const emailLine = document.createElement('p');
    emailLine.className = 'text-small text-secondary';
    emailLine.textContent = item.email;
    nameCell.append(nameLine, emailLine);

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));

    const assignedCell = document.createElement('td');
    assignedCell.textContent = item.assignedToName || '—';

    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(item.createdAt);

    row.append(nameCell, statusCell, assignedCell, dateCell);
    return row;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    const variants = { new: 'badge--info', reviewed: 'badge--warning', responded: 'badge--success', closed: 'badge--info' };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = labelize(status);
    return badge;
  }

  function bindDrawer() {
    drawer.querySelectorAll('[data-drawer-close]').forEach((btn) => btn.addEventListener('click', closeDrawer));
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
    });

    drawerEls.status.addEventListener('change', () => saveField({ status: drawerEls.status.value }));
    drawerEls.assignee.addEventListener('change', () => saveField({ assignedTo: drawerEls.assignee.value ? Number(drawerEls.assignee.value) : null }));
    drawerEls.addNoteButton.addEventListener('click', addNote);
  }

  async function openDrawer(id) {
    state.drawerId = id;
    drawerEls.error.hidden = true;
    drawer.returnFocusTo = document.activeElement;
    drawer.hidden = false;
    drawerEls.name.textContent = 'Loading…';
    try {
      const detail = await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}/${id}`);
      renderDrawer(detail);
      drawerEls.status.focus();
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not load this contact message.';
      drawerEls.error.hidden = false;
    }
  }

  function closeDrawer() {
    drawer.hidden = true;
    state.drawerId = null;
    if (drawer.returnFocusTo && document.contains(drawer.returnFocusTo)) drawer.returnFocusTo.focus();
    drawer.returnFocusTo = null;
  }

  function renderDrawer(detail) {
    drawerEls.name.textContent = detail.name;
    drawerEls.meta.textContent = formatDate(detail.createdAt);
    drawerEls.email.textContent = detail.email;
    if (detail.phone) {
      drawerEls.phoneRow.hidden = false;
      drawerEls.phone.textContent = detail.phone;
    } else {
      drawerEls.phoneRow.hidden = true;
    }
    drawerEls.message.textContent = detail.message;
    drawerEls.status.value = detail.status;
    drawerEls.assignee.value = detail.assignedTo ? String(detail.assignedTo) : '';
    drawerEls.mailto.href = `mailto:${encodeURIComponent(detail.email)}?subject=${encodeURIComponent('Re: your message — Robayer WealthLab')}`;
    renderNotes(detail.notes);
  }

  function renderNotes(notes) {
    drawerEls.notes.innerHTML = '';
    drawerEls.notesEmpty.hidden = notes.length > 0;
    notes.forEach((note) => {
      const wrap = document.createElement('div');
      wrap.className = 'drawer__note';
      const meta = document.createElement('p');
      meta.className = 'drawer__note-meta';
      meta.textContent = `${note.authorName || 'Unknown'} · ${formatDate(note.createdAt)}`;
      const body = document.createElement('p');
      body.textContent = note.note;
      wrap.append(meta, body);
      drawerEls.notes.appendChild(wrap);
    });
  }

  async function saveField(patch) {
    if (!state.drawerId) return;
    drawerEls.error.hidden = true;
    try {
      const updated = await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}/${state.drawerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      renderDrawer(updated);
      refresh();
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not save this change.';
      drawerEls.error.hidden = false;
    }
  }

  async function addNote() {
    if (!state.drawerId) return;
    const note = drawerEls.noteInput.value.trim();
    if (!note) return;
    drawerEls.addNoteButton.disabled = true;
    drawerEls.error.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}/${state.drawerId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      drawerEls.noteInput.value = '';
      const detail = await window.AdminAuth.adminFetch(`${CONTACTS_API_BASE}/${state.drawerId}`);
      renderDrawer(detail);
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not add this note.';
      drawerEls.error.hidden = false;
    } finally {
      drawerEls.addNoteButton.disabled = false;
    }
  }
}

function formatDate(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminContacts);
