/**
 * Robayer WealthLab — Orders admin page (Version 2.0 Phase 3, Operational
 * Visibility)
 *
 * Read-only list/drawer over `purchase_sessions`, same list/drawer shell
 * as admin-consultations.js/admin-contacts.js. The one real difference:
 * the two resend actions are role-gated — `super_admin`/`editor` only,
 * enforced server-side (routes/admin/orders.ts's `requireRole()`) and
 * mirrored here by hiding (not just disabling) the resend buttons for
 * a `support`-role admin, per docs/v2.0-phase3-architecture-plan.md's
 * explicit call-out that this is the one Phase 3 module with a real,
 * external, customer-facing consequence (an unwanted email).
 */

const ORDERS_API_BASE = '/api/admin/orders';

function initAdminOrders() {
  const root = document.querySelector('[data-orders-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
    drawerReference: null,
    canResend: false,
  };

  const els = {
    loadError: root.querySelector('[data-orders-load-error]'),
    searchInput: root.querySelector('[data-orders-search]'),
    dateFrom: root.querySelector('[data-orders-date-from]'),
    dateTo: root.querySelector('[data-orders-date-to]'),
    resultCount: root.querySelector('[data-orders-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-orders-status-filter]')),
    emptyState: root.querySelector('[data-orders-empty]'),
    emptyTitle: root.querySelector('[data-orders-empty-title]'),
    emptyBody: root.querySelector('[data-orders-empty-body]'),
    tableWrap: root.querySelector('[data-orders-table-wrap]'),
    tableBody: root.querySelector('[data-orders-table-body]'),
    pagination: root.querySelector('[data-orders-pagination]'),
    paginationLabel: root.querySelector('[data-orders-pagination-label]'),
    paginationPrev: root.querySelector('[data-orders-pagination-prev]'),
    paginationNext: root.querySelector('[data-orders-pagination-next]'),
  };

  const drawer = document.querySelector('[data-order-drawer]');
  const drawerEls = {
    reference: drawer.querySelector('[data-order-drawer-reference]'),
    meta: drawer.querySelector('[data-order-drawer-meta]'),
    error: drawer.querySelector('[data-order-drawer-error]'),
    testFlag: drawer.querySelector('[data-order-drawer-test-flag]'),
    product: drawer.querySelector('[data-order-drawer-product]'),
    email: drawer.querySelector('[data-order-drawer-email]'),
    amount: drawer.querySelector('[data-order-drawer-amount]'),
    statusBadge: drawer.querySelector('[data-order-drawer-status-badge]'),
    transactions: drawer.querySelector('[data-order-drawer-transactions]'),
    transactionsEmpty: drawer.querySelector('[data-order-drawer-transactions-empty]'),
    deliveries: drawer.querySelector('[data-order-drawer-deliveries]'),
    deliveriesEmpty: drawer.querySelector('[data-order-drawer-deliveries-empty]'),
    emails: drawer.querySelector('[data-order-drawer-emails]'),
    emailsEmpty: drawer.querySelector('[data-order-drawer-emails-empty]'),
    actions: drawer.querySelector('[data-order-drawer-actions]'),
    resendReceipt: drawer.querySelector('[data-order-drawer-resend-receipt]'),
    resendDownload: drawer.querySelector('[data-order-drawer-resend-download]'),
  };

  loadRole();
  bindToolbar();
  bindDrawer();
  refresh();

  async function loadRole() {
    try {
      const session = await window.AdminAuth.adminFetch('/api/admin/auth/session');
      state.canResend = session.role === 'super_admin' || session.role === 'editor';
    } catch {
      state.canResend = false;
    }
    drawerEls.actions.hidden = !state.canResend;
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
      if (state.dateFrom) params.set('dateFrom', state.dateFrom);
      if (state.dateTo) params.set('dateTo', state.dateTo);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${ORDERS_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load orders.';
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

    els.dateFrom.addEventListener('change', () => {
      state.dateFrom = els.dateFrom.value;
      state.page = 1;
      refresh();
    });
    els.dateTo.addEventListener('change', () => {
      state.dateTo = els.dateTo.value;
      state.page = 1;
      refresh();
    });

    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-orders-status-filter');
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
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-orders-status-filter') === state.status));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 order' : `${state.total} orders`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (state.search || state.status || state.dateFrom || state.dateTo) {
      els.emptyTitle.textContent = 'No orders match these filters';
      els.emptyBody.textContent = 'Try a different search or clear the filters above.';
    } else {
      els.emptyTitle.textContent = 'No orders yet';
      els.emptyBody.textContent = 'Purchases made through the site will appear here.';
    }
    if (!hasItems) return;

    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
  }

  function buildRow(item) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => openDrawer(item.purchaseReference));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDrawer(item.purchaseReference);
      }
    });

    const refCell = document.createElement('td');
    refCell.textContent = item.purchaseReference || '—';
    if (item.isSyntheticTest) {
      const testBadge = document.createElement('span');
      testBadge.className = 'badge badge--warning';
      testBadge.style.marginLeft = 'var(--space-2)';
      testBadge.textContent = 'Test';
      refCell.appendChild(testBadge);
    }

    const productCell = document.createElement('td');
    productCell.textContent = item.productTitle;

    const emailCell = document.createElement('td');
    emailCell.textContent = item.customerEmail || '—';

    const amountCell = document.createElement('td');
    amountCell.textContent = formatCurrency(item.amountPesewas, item.currency);

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));

    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(item.createdAt);

    row.append(refCell, productCell, emailCell, amountCell, statusCell, dateCell);
    return row;
  }

  const STATUS_BADGE_VARIANTS = {
    pending: 'badge--warning',
    verified: 'badge--success',
    failed: 'badge--error',
    expired: 'badge--info',
    cancelled: 'badge--error',
    refunded: 'badge--info',
  };

  function statusBadge(status) {
    const badge = document.createElement('span');
    updateStatusBadge(badge, status);
    return badge;
  }

  function updateStatusBadge(badge, status) {
    badge.className = `badge ${STATUS_BADGE_VARIANTS[status] || 'badge--info'}`;
    badge.textContent = labelize(status);
  }

  function bindDrawer() {
    drawer.querySelectorAll('[data-drawer-close]').forEach((btn) => btn.addEventListener('click', closeDrawer));
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
    });

    drawerEls.resendReceipt.addEventListener('click', () => resend('resend-receipt', drawerEls.resendReceipt));
    drawerEls.resendDownload.addEventListener('click', () => resend('resend-download', drawerEls.resendDownload));
  }

  async function openDrawer(reference) {
    if (!reference) return;
    state.drawerReference = reference;
    drawerEls.error.hidden = true;
    drawer.returnFocusTo = document.activeElement;
    drawer.hidden = false;
    drawerEls.reference.textContent = 'Loading…';
    try {
      const detail = await window.AdminAuth.adminFetch(`${ORDERS_API_BASE}/${encodeURIComponent(reference)}`);
      renderDrawer(detail);
      drawerEls.reference.focus();
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not load this order.';
      drawerEls.error.hidden = false;
    }
  }

  function closeDrawer() {
    drawer.hidden = true;
    state.drawerReference = null;
    if (drawer.returnFocusTo && document.contains(drawer.returnFocusTo)) drawer.returnFocusTo.focus();
    drawer.returnFocusTo = null;
  }

  function renderDrawer(detail) {
    drawerEls.reference.textContent = detail.purchaseReference || '—';
    drawerEls.meta.textContent = formatDate(detail.createdAt);
    drawerEls.testFlag.hidden = !detail.isSyntheticTest;
    drawerEls.product.textContent = detail.productTitle;
    drawerEls.email.textContent = detail.customerEmail || '—';
    drawerEls.amount.textContent = formatCurrency(detail.amountPesewas, detail.currency);
    updateStatusBadge(drawerEls.statusBadge, detail.status);

    renderTransactions(detail.transactions);
    renderDeliveries(detail.deliveries);
    renderEmails(detail.emails);

    const canResendThisOrder = state.canResend && detail.status === 'verified' && !!detail.customerEmail;
    drawerEls.actions.hidden = !state.canResend;
    drawerEls.resendReceipt.disabled = !canResendThisOrder;
    drawerEls.resendDownload.disabled = !canResendThisOrder;
  }

  function renderTransactions(transactions) {
    drawerEls.transactions.innerHTML = '';
    drawerEls.transactionsEmpty.hidden = transactions.length > 0;
    transactions.forEach((tx) => {
      const wrap = document.createElement('div');
      wrap.className = 'drawer__note';
      const meta = document.createElement('p');
      meta.className = 'drawer__note-meta';
      meta.textContent = `${tx.eventType} · ${formatDate(tx.createdAt)}`;
      const body = document.createElement('p');
      body.textContent = `${tx.paystackReference} — ${formatCurrency(tx.amountPesewas, tx.currency)} (${labelize(tx.status)})`;
      wrap.append(meta, body);
      drawerEls.transactions.appendChild(wrap);
    });
  }

  function renderDeliveries(deliveries) {
    drawerEls.deliveries.innerHTML = '';
    drawerEls.deliveriesEmpty.hidden = deliveries.length > 0;
    deliveries.forEach((delivery) => {
      const wrap = document.createElement('div');
      wrap.className = 'drawer__note';
      const meta = document.createElement('p');
      meta.className = 'drawer__note-meta';
      const limit = delivery.maxDownloads === null ? 'unlimited' : `${delivery.downloadsUsed}/${delivery.maxDownloads}`;
      meta.textContent = `${delivery.assetId} · ${limit} downloads · ${labelize(delivery.status)}`;
      const body = document.createElement('p');
      body.textContent = delivery.deliveredAt ? `Delivered ${formatDate(delivery.deliveredAt)}` : 'Not yet delivered';
      wrap.append(meta, body);
      drawerEls.deliveries.appendChild(wrap);
    });
  }

  function renderEmails(emails) {
    drawerEls.emails.innerHTML = '';
    drawerEls.emailsEmpty.hidden = emails.length > 0;
    emails.forEach((email) => {
      const wrap = document.createElement('div');
      wrap.className = 'drawer__note';
      const meta = document.createElement('p');
      meta.className = 'drawer__note-meta';
      meta.textContent = `${email.template} · ${formatDate(email.createdAt)}`;
      const body = document.createElement('p');
      body.textContent = `${email.recipient} — ${labelize(email.status)}`;
      wrap.append(meta, body);
      drawerEls.emails.appendChild(wrap);
    });
  }

  async function resend(action, button) {
    if (!state.drawerReference) return;
    button.disabled = true;
    drawerEls.error.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${ORDERS_API_BASE}/${encodeURIComponent(state.drawerReference)}/${action}`, { method: 'POST' });
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not send this email.';
      drawerEls.error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }
}

/** Same GH₵ formatting convention as admin-dashboard.js's own formatCurrency() — a small local copy per independent page family, not a shared utility (see that file's own header comment for the reasoning). */
function formatCurrency(amountPesewas, currency) {
  const symbol = currency === 'GHS' ? 'GH₵' : `${currency} `;
  const display = (amountPesewas / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${display}`;
}

function formatDate(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminOrders);
