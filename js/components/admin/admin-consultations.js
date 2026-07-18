/**
 * Robayer WealthLab — Consultation Manager admin page (Version 2.0
 * Phase 3, Operational Visibility)
 *
 * Runs after admin-shell.js's `requireSession()` gate (both listen for
 * `partials:loaded`; shell script order guarantees the gate runs
 * first), matching admin-products.js's established pattern for this
 * codebase's admin modules — same `adminFetch()`/drawer/focus-management
 * conventions.
 */

const CONSULTATIONS_API_BASE = '/api/admin/consultations';

function initAdminConsultations() {
  const root = document.querySelector('[data-consultations-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    category: '',
    assignedTo: '',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
    admins: [],
    drawerId: null,
  };

  const els = {
    loadError: root.querySelector('[data-consultations-load-error]'),
    searchInput: root.querySelector('[data-consultations-search]'),
    categorySelect: root.querySelector('[data-consultations-category]'),
    assigneeSelect: root.querySelector('[data-consultations-assignee]'),
    resultCount: root.querySelector('[data-consultations-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-consultations-status-filter]')),
    emptyState: root.querySelector('[data-consultations-empty]'),
    emptyTitle: root.querySelector('[data-consultations-empty-title]'),
    emptyBody: root.querySelector('[data-consultations-empty-body]'),
    tableWrap: root.querySelector('[data-consultations-table-wrap]'),
    tableBody: root.querySelector('[data-consultations-table-body]'),
    pagination: root.querySelector('[data-consultations-pagination]'),
    paginationLabel: root.querySelector('[data-consultations-pagination-label]'),
    paginationPrev: root.querySelector('[data-consultations-pagination-prev]'),
    paginationNext: root.querySelector('[data-consultations-pagination-next]'),
  };

  const drawer = document.querySelector('[data-consultations-drawer]');
  const drawerEls = {
    name: drawer.querySelector('[data-consultation-drawer-name]'),
    meta: drawer.querySelector('[data-consultation-drawer-meta]'),
    error: drawer.querySelector('[data-consultation-drawer-error]'),
    email: drawer.querySelector('[data-consultation-drawer-email]'),
    phoneRow: drawer.querySelector('[data-consultation-drawer-phone-row]'),
    phone: drawer.querySelector('[data-consultation-drawer-phone]'),
    country: drawer.querySelector('[data-consultation-drawer-country]'),
    contactMethod: drawer.querySelector('[data-consultation-drawer-contact-method]'),
    description: drawer.querySelector('[data-consultation-drawer-description]'),
    status: drawer.querySelector('[data-consultation-drawer-status]'),
    assignee: drawer.querySelector('[data-consultation-drawer-assignee]'),
    notes: drawer.querySelector('[data-consultation-drawer-notes]'),
    notesEmpty: drawer.querySelector('[data-consultation-drawer-notes-empty]'),
    noteInput: drawer.querySelector('[data-consultation-drawer-note-input]'),
    addNoteButton: drawer.querySelector('[data-consultation-drawer-add-note]'),
    mailto: drawer.querySelector('[data-consultation-drawer-mailto]'),
  };

  loadMeta();
  bindToolbar();
  bindDrawer();
  refresh();

  // ---------- Meta (assignable admins for filter + drawer) ----------

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}/meta`);
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

  // ---------- Data loading ----------

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      if (state.search) params.set('search', state.search);
      if (state.status) params.set('status', state.status);
      if (state.category) params.set('category', state.category);
      if (state.assignedTo === 'unassigned') {
        // No server-side "unassigned" filter exists — filtered client-side below instead of adding a one-off API param for a single UI convenience.
      } else if (state.assignedTo) {
        params.set('assignedTo', state.assignedTo);
      }
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}?${params.toString()}`);
      state.items = state.assignedTo === 'unassigned' ? result.items.filter((item) => !item.assignedTo) : result.items;
      state.total = state.assignedTo === 'unassigned' ? state.items.length : result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load consultation requests.';
      els.loadError.hidden = false;
    }
  }

  // ---------- Toolbar ----------

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

    els.categorySelect.addEventListener('change', () => {
      state.category = els.categorySelect.value;
      state.page = 1;
      refresh();
    });
    els.assigneeSelect.addEventListener('change', () => {
      state.assignedTo = els.assigneeSelect.value;
      state.page = 1;
      refresh();
    });

    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-consultations-status-filter');
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
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-consultations-status-filter') === state.status));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 request' : `${state.total} requests`;
  }

  // ---------- Table rendering ----------

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (state.search || state.status || state.category || state.assignedTo) {
      els.emptyTitle.textContent = 'No consultation requests match these filters';
      els.emptyBody.textContent = 'Try a different search or clear the filters above.';
    } else {
      els.emptyTitle.textContent = 'No consultation requests yet';
      els.emptyBody.textContent = 'New requests submitted through the public consultation form will appear here.';
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

    const categoryCell = document.createElement('td');
    categoryCell.textContent = labelize(item.category);

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));

    const assignedCell = document.createElement('td');
    assignedCell.textContent = item.assignedToName || '—';

    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(item.createdAt);

    row.append(nameCell, categoryCell, statusCell, assignedCell, dateCell);
    return row;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    const variants = { new: 'badge--info', reviewed: 'badge--warning', responded: 'badge--success', closed: 'badge--info' };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = labelize(status);
    return badge;
  }

  // ---------- Drawer ----------

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
      const detail = await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}/${id}`);
      renderDrawer(detail);
      drawerEls.status.focus();
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not load this consultation request.';
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
    drawerEls.meta.textContent = `${labelize(detail.category)} · ${formatDate(detail.createdAt)}`;
    drawerEls.email.textContent = detail.email;
    if (detail.phone) {
      drawerEls.phoneRow.hidden = false;
      drawerEls.phone.textContent = detail.phone;
    } else {
      drawerEls.phoneRow.hidden = true;
    }
    drawerEls.country.textContent = detail.country;
    drawerEls.contactMethod.textContent = labelize(detail.preferredContactMethod);
    drawerEls.description.textContent = detail.description;
    drawerEls.status.value = detail.status;
    drawerEls.assignee.value = detail.assignedTo ? String(detail.assignedTo) : '';
    drawerEls.mailto.href = `mailto:${detail.email}?subject=${encodeURIComponent('Re: your consultation request — Robayer WealthLab')}`;
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
      const updated = await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}/${state.drawerId}`, {
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
      await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}/${state.drawerId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      drawerEls.noteInput.value = '';
      const detail = await window.AdminAuth.adminFetch(`${CONSULTATIONS_API_BASE}/${state.drawerId}`);
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

document.addEventListener('partials:loaded', initAdminConsultations);
