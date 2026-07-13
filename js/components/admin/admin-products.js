/**
 * Robayer WealthLab — Products admin list page (Version 2.0 Phase 2)
 *
 * Drives admin/products/index.html. Runs after admin-shell.js's
 * `requireSession()` gate (both listen for `partials:loaded`; shell
 * script order guarantees the gate runs first), matching
 * admin-media.js's established pattern for this codebase's admin
 * modules — same `adminFetch()`/modal/focus-management conventions.
 */

const PRODUCTS_API_BASE = '/api/admin/products';

function initAdminProducts() {
  const root = document.querySelector('[data-products-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    topic: '',
    productType: '',
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
    loadError: root.querySelector('[data-products-load-error]'),
    searchInput: root.querySelector('[data-products-search]'),
    topicSelect: root.querySelector('[data-products-topic]'),
    typeSelect: root.querySelector('[data-products-type]'),
    sortSelect: root.querySelector('[data-products-sort]'),
    resultCount: root.querySelector('[data-products-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-products-status-filter]')),
    featuredChip: root.querySelector('[data-products-featured-filter]'),
    deletedChip: root.querySelector('[data-products-deleted-filter]'),
    bulkBar: root.querySelector('[data-products-bulk-bar]'),
    bulkCount: root.querySelector('[data-products-bulk-count]'),
    bulkRestoreStatusBtn: root.querySelector('[data-products-bulk-restore-status]'),
    bulkRestoreBtn: root.querySelector('[data-products-bulk-restore-action]'),
    bulkDeleteBtn: root.querySelector('[data-products-bulk-delete-action]'),
    emptyState: root.querySelector('[data-products-empty]'),
    tableWrap: root.querySelector('[data-products-table-wrap]'),
    tableBody: root.querySelector('[data-products-table-body]'),
    selectAll: root.querySelector('[data-products-select-all]'),
    pagination: root.querySelector('[data-products-pagination]'),
    paginationLabel: root.querySelector('[data-products-pagination-label]'),
    paginationPrev: root.querySelector('[data-products-pagination-prev]'),
    paginationNext: root.querySelector('[data-products-pagination-next]'),
  };

  const deleteModal = document.querySelector('[data-products-delete-modal]');

  loadMeta();
  bindToolbar();
  bindBulkBar();
  bindModals();
  refresh();

  // ---------- Meta (topics / product types for filter dropdowns) ----------

  async function loadMeta() {
    try {
      const meta = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/meta`);
      meta.topics.forEach((topic) => els.topicSelect.appendChild(new Option(labelize(topic), topic)));
      meta.productTypes.forEach((type) => els.typeSelect.appendChild(new Option(labelize(type), type)));
    } catch {
      // Filter dropdowns simply stay at "All" if this fails — not fatal to the page.
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
      if (state.topic) params.set('topic', state.topic);
      if (state.productType) params.set('productType', state.productType);
      if (state.featured) params.set('featured', 'true');
      if (state.showDeleted) params.set('deleted', 'true');
      params.set('sort', state.sort);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      state.selected.clear();
      renderTable();
      renderPagination();
      renderBulkBar();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load products.';
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

    els.topicSelect.addEventListener('change', () => {
      state.topic = els.topicSelect.value;
      state.page = 1;
      refresh();
    });
    els.typeSelect.addEventListener('change', () => {
      state.productType = els.typeSelect.value;
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
        state.status = chip.getAttribute('data-products-status-filter');
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
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-products-status-filter') === state.status && !state.showDeleted));
    });
    els.featuredChip.setAttribute('aria-pressed', String(state.featured));
    els.deletedChip.setAttribute('aria-pressed', String(state.showDeleted));
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 product' : `${state.total} products`;
  }

  // ---------- Table rendering ----------

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
    titleLink.href = `/admin/products/edit/?id=${item.id}`;
    titleLink.textContent = item.title;
    const slugLine = document.createElement('p');
    slugLine.className = 'text-small text-secondary';
    slugLine.textContent = item.slug + (item.sku ? ` · ${item.sku}` : '');
    titleCell.append(titleLink, slugLine);

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status, item.deletedAt));

    const topicCell = document.createElement('td');
    topicCell.textContent = labelize(item.topic);

    const typeCell = document.createElement('td');
    typeCell.textContent = labelize(item.productType);

    const priceCell = document.createElement('td');
    priceCell.className = 'numeric';
    priceCell.textContent = item.price === null ? '—' : `${item.currency} ${item.price.toFixed(2)}`;

    const updatedCell = document.createElement('td');
    updatedCell.textContent = formatDate(item.updatedAt);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'admin-table-row-actions';
    actionsCell.append(...rowActions(item));

    row.append(checkboxCell, titleCell, statusCell, topicCell, typeCell, priceCell, updatedCell, actionsCell);
    return row;
  }

  function statusBadge(status, deletedAt) {
    const badge = document.createElement('span');
    const variants = {
      active: 'badge--success',
      draft: 'badge--info',
      'coming-soon': 'badge--info',
      archived: 'badge--warning',
      hidden: 'badge--warning',
      unavailable: 'badge--error',
    };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = deletedAt ? 'Deleted' : labelize(status);
    return badge;
  }

  function rowActions(item) {
    const editLink = document.createElement('a');
    editLink.href = `/admin/products/edit/?id=${item.id}`;
    editLink.className = 'btn btn--secondary';
    editLink.textContent = 'Edit';

    const duplicateButton = document.createElement('button');
    duplicateButton.type = 'button';
    duplicateButton.className = 'btn btn--secondary';
    duplicateButton.textContent = 'Duplicate';
    duplicateButton.addEventListener('click', () => duplicateProduct(item, duplicateButton));

    if (item.deletedAt) {
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'btn btn--secondary';
      restoreButton.textContent = 'Restore';
      restoreButton.addEventListener('click', () => restoreProduct(item, restoreButton));
      return [editLink, restoreButton];
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn--secondary';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => openDeleteConfirm(item));

    return [editLink, duplicateButton, deleteButton];
  }

  async function duplicateProduct(item, button) {
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${item.id}/duplicate`, { method: 'POST' });
      refresh();
    } catch (error) {
      alert(error.message || 'Could not duplicate this product.'); // eslint-disable-line no-alert -- no toast component exists yet; matches admin-media.js's current error-surfacing convention
    } finally {
      button.disabled = false;
    }
  }

  async function restoreProduct(item, button) {
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${item.id}/restore`, { method: 'POST' });
    } catch (error) {
      alert(error.message || 'Could not restore this product.'); // eslint-disable-line no-alert
    } finally {
      button.disabled = false;
      refresh();
    }
  }

  // ---------- Delete modal ----------

  function bindModals() {
    deleteModal.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(deleteModal)));
    deleteModal.addEventListener('click', (event) => {
      if (event.target === deleteModal) closeModal(deleteModal);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !deleteModal.hidden) closeModal(deleteModal);
    });
    deleteModal.querySelector('[data-products-delete-confirm]').addEventListener('click', async () => {
      await deleteProduct(deleteModal.currentItem);
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
    deleteModal.querySelector('[data-products-delete-title]').textContent = `Delete "${item.title}"?`;
    openModal(deleteModal);
  }

  async function deleteProduct(item) {
    if (!item) return;
    // Disabling the button (rather than just awaiting the fetch) closes
    // the double-submission window a real, impatient double-click opens;
    // refresh() ALWAYS running afterward (not just on success) means the
    // table re-syncs with server truth even if a race already resolved
    // the request — same fix as admin-media.js's deleteItem().
    const button = deleteModal.querySelector('[data-products-delete-confirm]');
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/${item.id}`, { method: 'DELETE' });
    } catch (error) {
      alert(error.message || 'Could not delete this product.'); // eslint-disable-line no-alert
    } finally {
      button.disabled = false;
      refresh();
    }
  }

  // ---------- Bulk actions ----------

  function bindBulkBar() {
    els.bulkBar.querySelectorAll('[data-products-bulk-action]').forEach((button) => {
      button.addEventListener('click', () => runBulkAction(button.getAttribute('data-products-bulk-action'), button));
    });
  }

  function renderBulkBar() {
    const count = state.selected.size;
    els.bulkBar.hidden = count === 0;
    if (count === 0) return;
    els.bulkCount.textContent = count === 1 ? '1 selected' : `${count} selected`;
    els.bulkRestoreStatusBtn.hidden = !state.showDeleted;
    els.bulkRestoreBtn.hidden = !state.showDeleted;
    els.bulkBar.querySelectorAll('[data-products-bulk-action="publish"], [data-products-bulk-action="unpublish"], [data-products-bulk-action="archive"]').forEach((btn) => {
      btn.hidden = state.showDeleted;
    });
    els.bulkDeleteBtn.hidden = state.showDeleted;
  }

  async function runBulkAction(action, button) {
    if (state.selected.size === 0) return;
    if (action === 'delete' && !confirm(`Delete ${state.selected.size} product(s)? They can be restored later.`)) return; // eslint-disable-line no-alert -- no toast/confirm component exists yet
    button.disabled = true;
    try {
      await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}/bulk`, {
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

document.addEventListener('partials:loaded', initAdminProducts);
