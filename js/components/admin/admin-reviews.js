/**
 * Robayer WealthLab — Review Moderation admin page (Version 3.2
 * Milestone M4, Reviews & Coupons).
 *
 * Runs after admin-shell.js's requireSession() gate, same
 * adminFetch()/pagination conventions as admin-consultations.js. No
 * drawer — moderation is a single binary decision (approve/reject) per
 * row, so inline row actions are sufficient; a full-detail drawer
 * would only add clicks for no real benefit here.
 */

const REVIEWS_API_BASE = '/api/admin/reviews';

function initAdminReviews() {
  const root = document.querySelector('[data-reviews-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    status: '',
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
  };

  const els = {
    loadError: root.querySelector('[data-reviews-load-error]'),
    actionSuccess: root.querySelector('[data-reviews-action-success]'),
    resultCount: root.querySelector('[data-reviews-result-count]'),
    statusChips: Array.from(root.querySelectorAll('[data-reviews-status-filter]')),
    emptyState: root.querySelector('[data-reviews-empty]'),
    emptyTitle: root.querySelector('[data-reviews-empty-title]'),
    emptyBody: root.querySelector('[data-reviews-empty-body]'),
    tableWrap: root.querySelector('[data-reviews-table-wrap]'),
    tableBody: root.querySelector('[data-reviews-table-body]'),
    pagination: root.querySelector('[data-reviews-pagination]'),
    paginationLabel: root.querySelector('[data-reviews-pagination-label]'),
    paginationPrev: root.querySelector('[data-reviews-pagination-prev]'),
    paginationNext: root.querySelector('[data-reviews-pagination-next]'),
  };

  bindToolbar();
  refresh();

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      if (state.status) params.set('status', state.status);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${REVIEWS_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load reviews.';
      els.loadError.hidden = false;
    }
  }

  function bindToolbar() {
    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-reviews-status-filter');
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
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-reviews-status-filter') === state.status));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 review' : `${state.total} reviews`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (state.status) {
      els.emptyTitle.textContent = 'No reviews match this filter';
      els.emptyBody.textContent = 'Try a different status filter.';
    } else {
      els.emptyTitle.textContent = 'No reviews yet';
      els.emptyBody.textContent = 'Reviews submitted by customers with a verified purchase will appear here for moderation.';
    }
    if (!hasItems) return;

    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
  }

  function buildRow(item) {
    const row = document.createElement('tr');

    const productCell = document.createElement('td');
    productCell.textContent = item.productTitle;

    const reviewerCell = document.createElement('td');
    reviewerCell.className = 'text-small text-secondary';
    reviewerCell.textContent = item.customerEmail;

    const ratingCell = document.createElement('td');
    ratingCell.textContent = '★'.repeat(item.rating) + '☆'.repeat(5 - item.rating);

    const bodyCell = document.createElement('td');
    bodyCell.style.maxWidth = '360px';
    bodyCell.textContent = item.body;

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));

    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(item.createdAt);

    const actionsCell = document.createElement('td');
    if (item.status === 'pending') {
      const approveButton = document.createElement('button');
      approveButton.type = 'button';
      approveButton.className = 'btn btn--secondary';
      approveButton.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
      approveButton.textContent = 'Approve';
      approveButton.addEventListener('click', () => moderate(item.id, 'approved'));

      const rejectButton = document.createElement('button');
      rejectButton.type = 'button';
      rejectButton.className = 'btn btn--secondary';
      rejectButton.style.cssText = 'padding:6px 12px;font-size:var(--text-small);margin-left:var(--space-2);';
      rejectButton.textContent = 'Reject';
      rejectButton.addEventListener('click', () => moderate(item.id, 'rejected'));

      actionsCell.append(approveButton, rejectButton);
    } else {
      // Approving/rejecting again is still allowed (a moderator changing
      // their mind) — re-labeled so the button never claims to do
      // nothing when the review is already in that state.
      const otherStatus = item.status === 'approved' ? 'rejected' : 'approved';
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.className = 'btn btn--secondary';
      switchButton.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
      switchButton.textContent = otherStatus === 'approved' ? 'Approve instead' : 'Reject instead';
      switchButton.addEventListener('click', () => moderate(item.id, otherStatus));
      actionsCell.appendChild(switchButton);
    }

    row.append(productCell, reviewerCell, ratingCell, bodyCell, statusCell, dateCell, actionsCell);
    return row;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    const variants = { pending: 'badge--warning', approved: 'badge--success', rejected: 'badge--error' };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    return badge;
  }

  async function moderate(id, status) {
    els.loadError.hidden = true;
    els.actionSuccess.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${REVIEWS_API_BASE}/${id}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      els.actionSuccess.textContent = status === 'approved' ? 'Review approved.' : 'Review rejected.';
      els.actionSuccess.hidden = false;
      refresh();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not update this review.';
      els.loadError.hidden = false;
    }
  }
}

function formatDate(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminReviews);
