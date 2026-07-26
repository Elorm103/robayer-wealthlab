/**
 * Robayer WealthLab — Coupon Management admin page (Version 3.2
 * Milestone M4, Reviews & Coupons).
 *
 * Runs after admin-shell.js's requireSession() gate, same
 * adminFetch()/pagination conventions as admin-consultations.js and
 * admin-reviews.js. Code/discount/product are immutable once created
 * (see couponService.updateCoupon()'s own header comment) — only
 * status, maxRedemptions, and expiresAt are ever edited after the
 * fact, so this page's "edit" affordance is deliberately limited to
 * those three fields (a status toggle plus two small inline inputs),
 * not a full re-open-the-create-form flow.
 */

const COUPONS_API_BASE = '/api/admin/coupons';
const PRODUCTS_API_BASE = '/api/admin/products';

function initAdminCoupons() {
  const root = document.querySelector('[data-coupons-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
  };

  const els = {
    loadError: root.querySelector('[data-coupons-load-error]'),
    actionSuccess: root.querySelector('[data-coupons-action-success]'),
    resultCount: root.querySelector('[data-coupons-result-count]'),
    newToggle: root.querySelector('[data-coupons-new-toggle]'),
    newCancel: root.querySelector('[data-coupons-new-cancel]'),
    formPanel: root.querySelector('[data-coupons-form-panel]'),
    form: root.querySelector('[data-coupon-form]'),
    formError: root.querySelector('[data-coupon-form-error]'),
    productSelect: root.querySelector('#coupon-product'),
    emptyState: root.querySelector('[data-coupons-empty]'),
    tableWrap: root.querySelector('[data-coupons-table-wrap]'),
    tableBody: root.querySelector('[data-coupons-table-body]'),
    pagination: root.querySelector('[data-coupons-pagination]'),
    paginationLabel: root.querySelector('[data-coupons-pagination-label]'),
    paginationPrev: root.querySelector('[data-coupons-pagination-prev]'),
    paginationNext: root.querySelector('[data-coupons-pagination-next]'),
  };

  loadProducts();
  bindForm();
  bindPagination();
  refresh();

  async function loadProducts() {
    try {
      const result = await window.AdminAuth.adminFetch(`${PRODUCTS_API_BASE}?pageSize=100`);
      result.items.forEach((product) => {
        els.productSelect.appendChild(new Option(product.title, product.slug));
      });
    } catch {
      // The "All products" option still works if this fails — not fatal to the page.
    }
  }

  function bindForm() {
    els.newToggle.addEventListener('click', () => {
      els.formPanel.hidden = false;
      els.newToggle.hidden = true;
    });
    els.newCancel.addEventListener('click', () => {
      els.form.reset();
      els.formError.hidden = true;
      els.formPanel.hidden = true;
      els.newToggle.hidden = false;
    });

    els.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      els.formError.hidden = true;

      const code = els.form.querySelector('#coupon-code').value.trim();
      const productSlug = els.form.querySelector('#coupon-product').value || null;
      const discountType = els.form.querySelector('#coupon-discount-type').value;
      const discountValueRaw = els.form.querySelector('#coupon-discount-value').value;
      const maxRedemptionsRaw = els.form.querySelector('#coupon-max-redemptions').value;
      const expiresAtRaw = els.form.querySelector('#coupon-expires-at').value;
      const firstPurchaseOnly = els.form.querySelector('#coupon-first-purchase-only').checked;

      const discountValue = Number(discountValueRaw);
      if (!code || !Number.isInteger(discountValue) || discountValue <= 0) {
        els.formError.textContent = 'A coupon code and a positive whole-number discount value are required.';
        els.formError.hidden = false;
        return;
      }

      const submitButton = els.form.querySelector('[type="submit"]');
      submitButton.disabled = true;

      try {
        await window.AdminAuth.adminFetch(COUPONS_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            productSlug,
            discountType,
            discountValue,
            maxRedemptions: maxRedemptionsRaw ? Number(maxRedemptionsRaw) : null,
            firstPurchaseOnly,
            // Version 3.2 Milestone M4 (Reviews & Coupons) — <input type="date">
            // gives "YYYY-MM-DD"; the coupon's own validity check
            // (couponService.validateCoupon()) compares against the full
            // stored value as-is, so this is sent through unmodified
            // rather than reformatted into a datetime here.
            expiresAt: expiresAtRaw || null,
          }),
        });
        els.form.reset();
        els.formPanel.hidden = true;
        els.newToggle.hidden = false;
        els.actionSuccess.textContent = 'Coupon created.';
        els.actionSuccess.hidden = false;
        state.page = 1;
        refresh();
      } catch (error) {
        els.formError.textContent = error.message || 'Could not create this coupon.';
        els.formError.hidden = false;
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  function bindPagination() {
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

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const params = new URLSearchParams();
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));

      const result = await window.AdminAuth.adminFetch(`${COUPONS_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load coupons.';
      els.loadError.hidden = false;
    }
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 coupon' : `${state.total} coupons`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    if (!hasItems) return;

    state.items.forEach((item) => els.tableBody.appendChild(buildRow(item)));
  }

  function discountLabel(item) {
    return item.discountType === 'percentage' ? `${item.discountValue}% off` : formatPesewas(item.discountValue) + ' off';
  }

  function buildRow(item) {
    const row = document.createElement('tr');

    const codeCell = document.createElement('td');
    codeCell.style.fontFamily = 'var(--font-mono)';
    codeCell.textContent = item.code;

    const productCell = document.createElement('td');
    productCell.textContent = item.productSlug || 'All products';

    const discountCell = document.createElement('td');
    discountCell.textContent = discountLabel(item);

    const redemptionsCell = document.createElement('td');
    redemptionsCell.textContent = item.maxRedemptions === null ? `${item.redemptionsCount} (unlimited)` : `${item.redemptionsCount} / ${item.maxRedemptions}`;

    const expiresCell = document.createElement('td');
    expiresCell.textContent = item.expiresAt ? formatDate(item.expiresAt) : 'Never';

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.status));

    const actionsCell = document.createElement('td');
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'btn btn--secondary';
    toggleButton.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
    const nextStatus = item.status === 'active' ? 'disabled' : 'active';
    toggleButton.textContent = item.status === 'active' ? 'Deactivate' : 'Activate';
    toggleButton.disabled = item.status === 'expired';
    toggleButton.addEventListener('click', () => updateStatus(item.id, nextStatus));
    actionsCell.appendChild(toggleButton);

    row.append(codeCell, productCell, discountCell, redemptionsCell, expiresCell, statusCell, actionsCell);
    return row;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    const variants = { active: 'badge--success', disabled: 'badge--warning', expired: 'badge--error' };
    badge.className = `badge ${variants[status] || 'badge--info'}`;
    badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    return badge;
  }

  async function updateStatus(id, status) {
    els.loadError.hidden = true;
    els.actionSuccess.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${COUPONS_API_BASE}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      els.actionSuccess.textContent = status === 'active' ? 'Coupon activated.' : 'Coupon deactivated.';
      els.actionSuccess.hidden = false;
      refresh();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not update this coupon.';
      els.loadError.hidden = false;
    }
  }
}

function formatPesewas(pesewas) {
  const rounded = Math.round(pesewas) / 100;
  const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `GH₵${withSeparators}`;
}

function formatDate(isoString) {
  const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

document.addEventListener('partials:loaded', initAdminCoupons);
