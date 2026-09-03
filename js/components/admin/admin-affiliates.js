/**
 * Robayer WealthLab: Admin Affiliate Centre. Runs after
 * admin-shell.js's requireSession() gate (same convention as
 * admin-coupons.js/admin-reviews.js, see those files' own header
 * comments). Four tabs (Affiliates, Commissions, Payouts, Resources),
 * one shared adminFetch() data layer.
 */

const AFFILIATES_API = '/api/admin/affiliates';
const COMMISSIONS_API = '/api/admin/affiliate-commissions';
const PAYOUTS_API = '/api/admin/affiliate-payouts';
const RESOURCES_API = '/api/admin/affiliate-resources';

function formatPesewas(pesewas) {
  return `GH₵${(pesewas / 100).toFixed(2)}`;
}

/** Matches affiliate-earnings.js's own formatDate() exactly, so the affiliate and admin views of the same payout render identically. */
function formatDate(iso) {
  return iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function badgeClass(status) {
  const map = { pending: 'badge--warning', requested: 'badge--warning', approved: 'badge--info', payable: 'badge--success', paid: 'badge--success', rejected: 'badge--error', suspended: 'badge--error', reversed: 'badge--error', failed: 'badge--error', cancelled: 'badge--error', processing: 'badge--info' };
  return map[status] || 'badge--info';
}

function initAdminAffiliates() {
  const root = document.querySelector('[data-affiliates-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const errorEl = root.querySelector('[data-affiliates-error]');
  const successEl = root.querySelector('[data-affiliates-success]');

  function showError(message) {
    errorEl.hidden = false;
    errorEl.textContent = message;
    window.setTimeout(() => { errorEl.hidden = true; }, 6000);
  }
  function showSuccess(message) {
    successEl.hidden = false;
    successEl.textContent = message;
    window.setTimeout(() => { successEl.hidden = true; }, 4000);
  }

  // ---- Tabs ----
  root.querySelectorAll('[data-affiliates-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-affiliates-tab');
      root.querySelectorAll('[data-affiliates-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      root.querySelectorAll('[data-affiliates-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-affiliates-panel') !== target;
      });
      if (target === 'commissions') loadCommissions();
      if (target === 'payouts') loadPayouts();
      if (target === 'resources') loadResources();
    });
  });

  // ---- KPIs ----
  async function loadKpis() {
    try {
      const [pendingList, approvedList, payableCommissions, requestedPayouts] = await Promise.all([
        window.AdminAuth.adminFetch(`${AFFILIATES_API}?status=pending&pageSize=1`),
        window.AdminAuth.adminFetch(`${AFFILIATES_API}?status=approved&pageSize=1`),
        window.AdminAuth.adminFetch(`${COMMISSIONS_API}?status=payable&pageSize=1`),
        window.AdminAuth.adminFetch(`${PAYOUTS_API}?status=requested&pageSize=1`),
      ]);
      root.querySelector('[data-affiliates-kpi-pending]').textContent = pendingList.total;
      root.querySelector('[data-affiliates-kpi-approved]').textContent = approvedList.total;
      root.querySelector('[data-affiliates-kpi-payable]').textContent = payableCommissions.total;
      root.querySelector('[data-affiliates-kpi-payouts]').textContent = requestedPayouts.total;
    } catch {
      // KPI load failure isn't fatal to the rest of the page.
    }
  }

  // ---- Affiliates list ----
  const listEl = root.querySelector('[data-affiliates-list]');
  const statusFilter = root.querySelector('[data-affiliates-status-filter]');
  const searchInput = root.querySelector('[data-affiliates-search]');
  const detailPanel = root.querySelector('[data-affiliate-detail-panel]');
  const detailBody = root.querySelector('[data-affiliate-detail-body]');

  async function loadAffiliates() {
    const params = new URLSearchParams();
    if (statusFilter.value) params.set('status', statusFilter.value);
    if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
    try {
      const result = await window.AdminAuth.adminFetch(`${AFFILIATES_API}?${params.toString()}`);
      listEl.innerHTML = '';
      result.items.forEach((item) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><code>${escapeHtml(item.affiliateCode)}</code></td>
          <td>${escapeHtml(item.customerEmail)}</td>
          <td><span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span></td>
          <td class="numeric">${item.defaultCommissionPercent}%</td>
          <td>${escapeHtml((item.appliedAt || '').slice(0, 10))}</td>
          <td><button type="button" class="btn btn--secondary" data-view-affiliate="${item.id}">View</button></td>
        `;
        listEl.appendChild(row);
      });
      listEl.querySelectorAll('[data-view-affiliate]').forEach((btn) => {
        btn.addEventListener('click', () => openAffiliateDetail(Number(btn.getAttribute('data-view-affiliate'))));
      });
    } catch (error) {
      showError(error.message || 'Could not load affiliates.');
    }
  }

  statusFilter.addEventListener('change', loadAffiliates);
  let searchTimer;
  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(loadAffiliates, 300);
  });

  async function openAffiliateDetail(id) {
    try {
      const detail = await window.AdminAuth.adminFetch(`${AFFILIATES_API}/${id}`);
      detailPanel.hidden = false;
      detailBody.innerHTML = renderAffiliateDetail(detail);
      wireDetailActions(detail);
      detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      showError(error.message || 'Could not load this affiliate.');
    }
  }

  root.querySelector('[data-affiliate-detail-close]').addEventListener('click', () => {
    detailPanel.hidden = true;
  });

  function renderAffiliateDetail(d) {
    const rateRows = d.productRates.map((r) => `<li>${escapeHtml(r.productTitle)}: ${r.commissionPercent}%</li>`).join('') || '<li class="text-secondary">None set. Default rate applies to every product.</li>';
    return `
      <h2 class="mt-0 mb-2">${escapeHtml(d.customerEmail)} <span class="badge ${badgeClass(d.status)}">${escapeHtml(d.status)}</span></h2>
      <p class="text-mono text-secondary mb-3">${escapeHtml(d.affiliateCode)}</p>

      <div class="grid grid--4 mb-4">
        <div class="stat-card"><span class="stat-card__label">Clicks</span><span class="stat-card__value">${d.totals.clicks}</span></div>
        <div class="stat-card"><span class="stat-card__label">Conversions</span><span class="stat-card__value">${d.totals.conversions}</span></div>
        <div class="stat-card"><span class="stat-card__label">Revenue</span><span class="stat-card__value">${formatPesewas(d.totals.grossPesewas)}</span></div>
        <div class="stat-card"><span class="stat-card__label">Payable</span><span class="stat-card__value">${formatPesewas(d.totals.payablePesewas)}</span></div>
      </div>

      <h3 class="mb-2">Product-specific rates</h3>
      <ul class="mb-4">${rateRows}</ul>

      <div class="cluster gap-2 mb-4">
        ${d.status === 'pending' ? `
          <button type="button" class="btn btn--accent" data-action="approve">Approve</button>
          <button type="button" class="btn btn--secondary" data-action="reject">Reject</button>
        ` : ''}
        ${d.status === 'approved' ? `<button type="button" class="btn btn--secondary" data-action="suspend">Suspend</button>` : ''}
        ${d.status === 'suspended' ? `<button type="button" class="btn btn--accent" data-action="reactivate">Reactivate</button>` : ''}
      </div>

      <div class="field cluster gap-2">
        <label class="field__label" for="affiliate-default-rate">Default commission %</label>
        <input type="number" id="affiliate-default-rate" min="0" max="100" value="${d.defaultCommissionPercent}" class="field__input" style="max-width:100px;">
        <button type="button" class="btn btn--secondary" data-action="set-default-rate">Update</button>
      </div>
    `;
  }

  function wireDetailActions(d) {
    const approveBtn = detailBody.querySelector('[data-action="approve"]');
    if (approveBtn) approveBtn.addEventListener('click', () => moderateAffiliate(d.id, 'approved'));

    const rejectBtn = detailBody.querySelector('[data-action="reject"]');
    if (rejectBtn) rejectBtn.addEventListener('click', () => {
      const reason = window.prompt('Reason for rejection (optional):') || null;
      moderateAffiliate(d.id, 'rejected', reason);
    });

    const suspendBtn = detailBody.querySelector('[data-action="suspend"]');
    if (suspendBtn) suspendBtn.addEventListener('click', async () => {
      const reason = window.prompt('Reason for suspension (required):');
      if (!reason || reason.trim().length < 3) return;
      try {
        await window.AdminAuth.adminFetch(`${AFFILIATES_API}/${d.id}/suspend`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
        showSuccess('Affiliate suspended.');
        openAffiliateDetail(d.id);
        loadAffiliates();
      } catch (error) {
        showError(error.message || 'Could not suspend this affiliate.');
      }
    });

    const reactivateBtn = detailBody.querySelector('[data-action="reactivate"]');
    if (reactivateBtn) reactivateBtn.addEventListener('click', async () => {
      try {
        await window.AdminAuth.adminFetch(`${AFFILIATES_API}/${d.id}/reactivate`, { method: 'POST' });
        showSuccess('Affiliate reactivated.');
        openAffiliateDetail(d.id);
        loadAffiliates();
      } catch (error) {
        showError(error.message || 'Could not reactivate this affiliate.');
      }
    });

    const setRateBtn = detailBody.querySelector('[data-action="set-default-rate"]');
    if (setRateBtn) setRateBtn.addEventListener('click', async () => {
      const percent = Number(detailBody.querySelector('#affiliate-default-rate').value);
      try {
        await window.AdminAuth.adminFetch(`${AFFILIATES_API}/${d.id}/default-rate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ percent }) });
        showSuccess('Default rate updated.');
      } catch (error) {
        showError(error.message || 'Could not update the rate.');
      }
    });
  }

  async function moderateAffiliate(id, status, rejectionReason) {
    try {
      await window.AdminAuth.adminFetch(`${AFFILIATES_API}/${id}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, rejectionReason: rejectionReason || null }),
      });
      showSuccess(status === 'approved' ? 'Affiliate approved.' : 'Application rejected.');
      openAffiliateDetail(id);
      loadAffiliates();
      loadKpis();
    } catch (error) {
      showError(error.message || 'Could not update this application.');
    }
  }

  // ---- Commissions tab ----
  const commissionsList = root.querySelector('[data-commissions-list]');
  const commissionsFilter = root.querySelector('[data-commissions-status-filter]');

  async function loadCommissions() {
    const params = new URLSearchParams();
    if (commissionsFilter.value) params.set('status', commissionsFilter.value);
    try {
      const result = await window.AdminAuth.adminFetch(`${COMMISSIONS_API}?${params.toString()}`);
      commissionsList.innerHTML = '';
      result.items.forEach((item) => {
        const row = document.createElement('tr');
        const actions = [];
        if (item.status === 'pending') actions.push(`<button type="button" class="btn btn--secondary" data-approve-commission="${item.id}">Approve</button>`);
        if (item.status === 'approved') actions.push(`<button type="button" class="btn btn--secondary" data-payable-commission="${item.id}">Mark payable</button>`);
        row.innerHTML = `
          <td><code>${escapeHtml(item.affiliateCode)}</code></td>
          <td>${escapeHtml(item.productTitle)}</td>
          <td class="numeric">${formatPesewas(item.grossPesewas)}</td>
          <td class="numeric">${formatPesewas(item.commissionPesewas)}</td>
          <td><span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span></td>
          <td>${actions.join(' ')}</td>
        `;
        commissionsList.appendChild(row);
      });
      commissionsList.querySelectorAll('[data-approve-commission]').forEach((btn) => {
        btn.addEventListener('click', () => transitionCommission(btn.getAttribute('data-approve-commission'), 'approve'));
      });
      commissionsList.querySelectorAll('[data-payable-commission]').forEach((btn) => {
        btn.addEventListener('click', () => transitionCommission(btn.getAttribute('data-payable-commission'), 'payable'));
      });
    } catch (error) {
      showError(error.message || 'Could not load commissions.');
    }
  }

  async function transitionCommission(id, action) {
    try {
      await window.AdminAuth.adminFetch(`${COMMISSIONS_API}/${id}/${action}`, { method: 'POST' });
      showSuccess('Commission updated.');
      loadCommissions();
      loadKpis();
    } catch (error) {
      showError(error.message || 'Could not update this commission.');
    }
  }

  commissionsFilter.addEventListener('change', loadCommissions);

  // ---- Payouts tab ----
  const payoutsList = root.querySelector('[data-payouts-list]');
  const payoutsFilter = root.querySelector('[data-payouts-status-filter]');

  async function loadPayouts() {
    const params = new URLSearchParams();
    if (payoutsFilter.value) params.set('status', payoutsFilter.value);
    try {
      const result = await window.AdminAuth.adminFetch(`${PAYOUTS_API}?${params.toString()}`);
      payoutsList.innerHTML = '';
      result.items.forEach((item) => {
        const row = document.createElement('tr');
        const actions = [];
        if (item.status === 'requested') actions.push(`<button type="button" class="btn btn--secondary" data-payout-approve="${item.id}">Approve</button>`, `<button type="button" class="btn btn--secondary" data-payout-cancel="${item.id}">Cancel</button>`);
        if (item.status === 'approved' || item.status === 'processing') actions.push(`<button type="button" class="btn btn--accent" data-payout-process="${item.id}">Mark as Paid</button>`, `<button type="button" class="btn btn--secondary" data-payout-fail="${item.id}">Mark failed</button>`);
        row.innerHTML = `
          <td><code>${escapeHtml(item.affiliateCode)}</code></td>
          <td>${escapeHtml(item.customerEmail)}</td>
          <td class="numeric">${formatPesewas(item.amountPesewas)}</td>
          <td>${item.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</td>
          <td>${item.payoutDetails ? escapeHtml(item.payoutDetails) : '<span class="text-secondary">Not set</span>'}</td>
          <td>${formatDate(item.requestedAt)}</td>
          <td>${formatDate(item.approvedAt)}</td>
          <td>${item.reference ? escapeHtml(item.reference) : '-'}</td>
          <td><span class="badge ${badgeClass(item.status)}">${escapeHtml(item.status)}</span></td>
          <td>${actions.join(' ')}</td>
        `;
        payoutsList.appendChild(row);
      });
      payoutsList.querySelectorAll('[data-payout-approve]').forEach((btn) => btn.addEventListener('click', () => transitionPayout(btn.getAttribute('data-payout-approve'), 'approve')));
      payoutsList.querySelectorAll('[data-payout-cancel]').forEach((btn) => btn.addEventListener('click', () => {
        const reason = window.prompt('Reason for cancelling this payout:');
        if (reason) transitionPayout(btn.getAttribute('data-payout-cancel'), 'cancel', { reason });
      }));
      payoutsList.querySelectorAll('[data-payout-fail]').forEach((btn) => btn.addEventListener('click', () => {
        const reason = window.prompt('Reason this payout failed:');
        if (reason) transitionPayout(btn.getAttribute('data-payout-fail'), 'fail', { reason });
      }));
      payoutsList.querySelectorAll('[data-payout-process]').forEach((btn) => btn.addEventListener('click', () => {
        const reference = window.prompt('Enter the external transaction reference. This only RECORDS that you have ALREADY sent the payment manually via Mobile Money or bank transfer; it does not send any money itself:');
        if (reference) transitionPayout(btn.getAttribute('data-payout-process'), 'process', { reference });
      }));
    } catch (error) {
      showError(error.message || 'Could not load payouts.');
    }
  }

  async function transitionPayout(id, action, body) {
    try {
      await window.AdminAuth.adminFetch(`${PAYOUTS_API}/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      showSuccess('Payout updated.');
      loadPayouts();
      loadKpis();
    } catch (error) {
      showError(error.message || 'Could not update this payout.');
    }
  }

  payoutsFilter.addEventListener('change', loadPayouts);

  // ---- Resources tab ----
  const resourcesList = root.querySelector('[data-resources-list]');
  const resourceNewToggle = root.querySelector('[data-resource-new-toggle]');
  const resourceFormPanel = root.querySelector('[data-resource-form-panel]');
  const resourceForm = root.querySelector('[data-resource-form]');

  resourceNewToggle.addEventListener('click', () => {
    resourceFormPanel.hidden = !resourceFormPanel.hidden;
  });

  resourceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(resourceForm);
    try {
      await window.AdminAuth.adminFetch(RESOURCES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: formData.get('title'), category: formData.get('category'), resourceBody: formData.get('body') }),
      });
      showSuccess('Resource created.');
      resourceForm.reset();
      resourceFormPanel.hidden = true;
      loadResources();
    } catch (error) {
      showError(error.message || 'Could not create this resource.');
    }
  });

  async function loadResources() {
    try {
      const result = await window.AdminAuth.adminFetch(RESOURCES_API);
      resourcesList.innerHTML = '';
      result.resources.forEach((item) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${escapeHtml(item.title)}</td>
          <td>${escapeHtml(item.category)}</td>
          <td><span class="badge ${item.status === 'published' ? 'badge--success' : 'badge--info'}">${escapeHtml(item.status)}</span></td>
          <td>
            ${item.status === 'published' ? `<button type="button" class="btn btn--secondary" data-resource-archive="${item.id}">Archive</button>` : `<button type="button" class="btn btn--secondary" data-resource-publish="${item.id}">Publish</button>`}
          </td>
        `;
        resourcesList.appendChild(row);
      });
      resourcesList.querySelectorAll('[data-resource-archive]').forEach((btn) => btn.addEventListener('click', () => updateResourceStatus(btn.getAttribute('data-resource-archive'), 'archived')));
      resourcesList.querySelectorAll('[data-resource-publish]').forEach((btn) => btn.addEventListener('click', () => updateResourceStatus(btn.getAttribute('data-resource-publish'), 'published')));
    } catch (error) {
      showError(error.message || 'Could not load resources.');
    }
  }

  async function updateResourceStatus(id, status) {
    try {
      await window.AdminAuth.adminFetch(`${RESOURCES_API}/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      loadResources();
    } catch (error) {
      showError(error.message || 'Could not update this resource.');
    }
  }

  loadKpis();
  loadAffiliates();
}

document.addEventListener('partials:loaded', initAdminAffiliates);
