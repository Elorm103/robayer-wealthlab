/**
 * Robayer WealthLab — Blog admin list page (Version 2.1 Phase 2)
 *
 * Drives admin/blog/index.html. Runs after admin-shell.js's
 * `requireSession()` gate, matching admin-resources.js's established
 * pattern — a trimmed, field-renamed copy of it (author instead of
 * downloads column, no format filter, only publish/unpublish lifecycle
 * actions since Blog has just the 2 statuses).
 */

const BLOG_API_BASE = '/api/admin/blog';

function initAdminBlog() {
  const root = document.querySelector('[data-blog-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    category: '',
    featured: false,
    showDeleted: false,
    sort: 'newest',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
    selected: new Set(),
  };

  const els = {
    loadError: root.querySelector('[data-blog-load-error]'),
    searchInput: root.querySelector('[data-blog-search]'),
    categorySelect: root.querySelector('[data-blog-category]'),
    sortSelect: root.querySelector('[data-blog-sort]'),
    resultCount: root.querySelector('[data-blog-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-blog-status-filter]')),
    featuredChip: root.querySelector('[data-blog-featured-filter]'),
    deletedChip: root.querySelector('[data-blog-deleted-filter]'),
    bulkBar: root.querySelector('[data-blog-bulk-bar]'),
    bulkCount: root.querySelector('[data-blog-bulk-count]'),
    bulkRestoreBtn: root.querySelector('[data-blog-bulk-restore-action]'),
    bulkDeleteBtn: root.querySelector('[data-blog-bulk-delete-action]'),
    emptyState: root.querySelector('[data-blog-empty]'),
    tableWrap: root.querySelector('[data-blog-table-wrap]'),
    tableBody: root.querySelector('[data-blog-table-body]'),
    selectAll: root.querySelector('[data-blog-select-all]'),
    pagination: root.querySelector('[data-blog-pagination]'),
    paginationLabel: root.querySelector('[data-blog-pagination-label]'),
    paginationPrev: root.querySelector('[data-blog-pagination-prev]'),
    paginationNext: root.querySelector('[data-blog-pagination-next]'),
  };

  const deleteModal = document.querySelector('[data-blog-delete-modal]');

  loadMeta();
  bindToolbar();
  bindBulkBar();
  bindModals();
  refresh();

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/meta`);
      meta.categories.forEach((category) => els.categorySelect.appendChild(new Option(labelize(category), category)));
    } catch {
      // Filter dropdown simply stays at "All" if this fails — not fatal to the page.
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
      if (state.category) params.set('category', state.category);
      if (state.featured) params.set('featured', 'true');
      if (state.showDeleted) params.set('deleted', 'true');
      params.set('sort', state.sort);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${BLOG_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      state.selected.clear();
      renderTable();
      renderPagination();
      renderBulkBar();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load posts.';
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

    els.categorySelect.addEventListener('change', () => {
      state.category = els.categorySelect.value;
      state.page = 1;
      refresh();
    });
    els.sortSelect.addEventListener('change', () => {
      state.sort = els.sortSelect.value;
      state.page = 1;
      refresh();
    });

    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-blog-status-filter');
        state.showDeleted = false;
        state.page = 1;
        syncChips();
        refresh();
      });
    });
    els.featuredChip.addEventListener('click', () => {
      state.featured = !state.featured;
      state.page = 1;
      syncChips();
      refresh();
    });
    els.deletedChip.addEventListener('click', () => {
      state.showDeleted = !state.showDeleted;
      state.status = '';
      state.page = 1;
      syncChips();
      refresh();
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

    els.selectAll.addEventListener('change', () => {
      if (els.selectAll.checked) {
        state.items.forEach((item) => state.selected.add(item.id));
      } else {
        state.selected.clear();
      }
      renderTable();
      renderBulkBar();
    });
  }

  function syncChips() {
    els.statusChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-blog-status-filter') === state.status && !state.showDeleted));
    });
    els.featuredChip.setAttribute('aria-pressed', String(state.featured));
    els.deletedChip.setAttribute('aria-pressed', String(state.showDeleted));
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 post' : `${state.total} posts`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (!hasItems) return;

    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
    els.selectAll.checked = state.items.length > 0 && state.items.every((item) => state.selected.has(item.id));
  }

  function buildRow(item) {
    const row = document.createElement('tr');

    const checkboxCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select ${item.title}`);
    checkbox.checked = state.selected.has(item.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      renderBulkBar();
      els.selectAll.checked = state.items.every((i) => state.selected.has(i.id));
    });
    checkboxCell.appendChild(checkbox);

    const titleCell = document.createElement('td');
    const titleLink = document.createElement('a');
    titleLink.href = `/admin/blog/edit/?id=${item.id}`;
    titleLink.textContent = item.title;
    const slugLine = document.createElement('p');
    slugLine.className = 'text-small text-secondary';
    slugLine.textContent = item.slug + (item.featured ? ' · Featured' : '');
    titleCell.append(titleLink, slugLine);

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status, item.deletedAt));

    const categoryCell = document.createElement('td');
    categoryCell.textContent = labelize(item.category);

    const authorCell = document.createElement('td');
    authorCell.textContent = item.authorName || '—';

    const updatedCell = document.createElement('td');
    updatedCell.textContent = formatDate(item.updatedAt);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'admin-table-row-actions';
    actionsCell.append(...rowActions(item));

    row.append(checkboxCell, titleCell, statusCell, categoryCell, authorCell, updatedCell, actionsCell);
    return row;
  }

  function statusBadge(status, deletedAt) {
    const badge = document.createElement('span');
    const variants = { published: 'badge--success', draft: 'badge--info' };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = deletedAt ? 'Deleted' : labelize(status);
    return badge;
  }

  function rowActions(item) {
    const editLink = document.createElement('a');
    editLink.href = `/admin/blog/edit/?id=${item.id}`;
    editLink.className = 'btn btn--secondary';
    editLink.textContent = 'Edit';

    const duplicateButton = document.createElement('button');
    duplicateButton.type = 'button';
    duplicateButton.className = 'btn btn--secondary';
    duplicateButton.textContent = 'Duplicate';
    duplicateButton.addEventListener('click', () => duplicatePost(item, duplicateButton));

    if (item.deletedAt) {
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'btn btn--secondary';
      restoreButton.textContent = 'Restore';
      restoreButton.addEventListener('click', () => restorePost(item, restoreButton));
      return [editLink, restoreButton];
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn--secondary';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => openDeleteConfirm(item));

    return [editLink, duplicateButton, deleteButton];
  }

  async function duplicatePost(item, button) {
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${item.id}/duplicate`, { method: 'POST' });
      refresh();
    } catch (error) {
      alert(error.message || 'Could not duplicate this post.'); // eslint-disable-line no-alert -- no toast component exists yet; matches admin-resources.js's current error-surfacing convention
    } finally {
      button.disabled = false;
    }
  }

  async function restorePost(item, button) {
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${item.id}/restore`, { method: 'POST' });
    } catch (error) {
      alert(error.message || 'Could not restore this post.'); // eslint-disable-line no-alert
    } finally {
      button.disabled = false;
      refresh();
    }
  }

  function bindModals() {
    deleteModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(deleteModal)));
    deleteModal.addEventListener('click', (event) => {
      if (event.target === deleteModal) closeModal(deleteModal);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !deleteModal.hidden) closeModal(deleteModal);
    });
    deleteModal.querySelector('[data-blog-delete-confirm]').addEventListener('click', async () => {
      await deletePost(deleteModal.currentItem);
      closeModal(deleteModal);
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

  function openDeleteConfirm(item) {
    deleteModal.currentItem = item;
    deleteModal.querySelector('[data-blog-delete-title]').textContent = `Delete "${item.title}"?`;
    openModal(deleteModal);
  }

  async function deletePost(item) {
    if (!item) return;
    const button = deleteModal.querySelector('[data-blog-delete-confirm]');
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/${item.id}`, { method: 'DELETE' });
    } catch (error) {
      alert(error.message || 'Could not delete this post.'); // eslint-disable-line no-alert
    } finally {
      button.disabled = false;
      refresh();
    }
  }

  function bindBulkBar() {
    els.bulkBar.querySelectorAll('[data-blog-bulk-action]').forEach((button) => {
      button.addEventListener('click', () => runBulkAction(button.getAttribute('data-blog-bulk-action'), button));
    });
  }

  function renderBulkBar() {
    const count = state.selected.size;
    els.bulkBar.hidden = count === 0;
    if (count === 0) return;
    els.bulkCount.textContent = count === 1 ? '1 selected' : `${count} selected`;
    els.bulkRestoreBtn.hidden = !state.showDeleted;
    els.bulkBar.querySelectorAll('[data-blog-bulk-action="publish"], [data-blog-bulk-action="unpublish"]').forEach((btn) => {
      btn.hidden = state.showDeleted;
    });
    els.bulkDeleteBtn.hidden = state.showDeleted;
  }

  async function runBulkAction(action, button) {
    if (state.selected.size === 0) return;
    if (action === 'delete' && !confirm(`Delete ${state.selected.size} post(s)? They can be restored later.`)) return; // eslint-disable-line no-alert -- no toast/confirm component exists yet
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${BLOG_API_BASE}/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(state.selected), action }),
      });
    } catch (error) {
      alert(error.message || 'Could not complete this bulk action.'); // eslint-disable-line no-alert
    } finally {
      button.disabled = false;
      refresh();
    }
  }
}

function formatDate(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminBlog);
