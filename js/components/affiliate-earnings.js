/**
 * Robayer WealthLab: Affiliate Earnings Component. Drives
 * affiliate/earnings/index.html: commission history table, payout
 * request, and payout history. Every commission status is rendered
 * with a short, honest explanation (see STATUS_COPY below), never
 * just a bare status word, per the affiliate-trust product principle
 * ("I know exactly what I've earned and why").
 */

const STATUS_LABELS = {
  pending: { label: 'Pending', badge: 'badge--warning', copy: 'Purchase completed. Commission awaiting eligibility confirmation.' },
  approved: { label: 'Approved', badge: 'badge--info', copy: 'Confirmed and awaiting the payable window.' },
  payable: { label: 'Payable', badge: 'badge--success', copy: 'Ready to be included in your next payout.' },
  paid: { label: 'Paid', badge: 'badge--success', copy: 'Paid out to you.' },
  reversed: { label: 'Reversed', badge: 'badge--error', copy: 'The associated order was refunded or cancelled.' },
};

const PAYOUT_STATUS_LABELS = {
  requested: 'Requested',
  approved: 'Approved',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatPesewas(pesewas) {
  return `GH₵${(pesewas / 100).toFixed(2)}`;
}

function formatDate(iso) {
  return iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
}

async function initAffiliateEarnings() {
  const root = document.querySelector('[data-affiliate-earnings-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const loadingEl = document.querySelector('[data-affiliate-earnings-loading]');
  const errorEl = document.querySelector('[data-affiliate-earnings-error]');

  try {
    const [commissions, payouts] = await Promise.all([
      window.CustomerDashboard.customerFetch('/api/customer/affiliates/commissions?pageSize=50'),
      window.CustomerDashboard.customerFetch('/api/customer/affiliates/payouts'),
    ]);

    renderCommissions(commissions.items);
    renderPayouts(payouts.payouts, payouts.minPayoutPesewas);
    wirePayoutRequest();

    loadingEl.hidden = true;
    root.hidden = false;
  } catch (error) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = error.message || 'Could not load your earnings.';
  }
}

function renderCommissions(items) {
  const container = document.querySelector('[data-affiliate-commissions-list]');
  const emptyEl = document.querySelector('[data-affiliate-commissions-empty]');
  if (!items.length) {
    emptyEl.hidden = false;
    return;
  }

  const table = document.createElement('table');
  table.className = 'table';
  table.innerHTML = `
    <thead><tr><th>Date</th><th>Product</th><th class="numeric">Sale amount</th><th class="numeric">Commission</th><th>Status</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  items.forEach((item) => {
    const status = STATUS_LABELS[item.status] || { label: item.status, badge: 'badge--info', copy: '' };
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(item.createdAt)}</td>
      <td>${escapeHtml(item.productTitle)}</td>
      <td class="numeric">${formatPesewas(item.grossPesewas)}</td>
      <td class="numeric">${formatPesewas(item.commissionPesewas)}</td>
      <td><span class="badge ${status.badge}" title="${escapeHtml(status.copy)}">${status.label}</span></td>
    `;
    tbody.appendChild(row);
  });

  container.appendChild(table);
  container.hidden = false;
}

function renderPayouts(payouts, minPayoutPesewas) {
  const listEl = document.querySelector('[data-affiliate-payouts-list]');
  const thresholdEl = document.querySelector('[data-affiliate-payout-threshold]');
  if (thresholdEl) thresholdEl.textContent = formatPesewas(minPayoutPesewas);

  if (!payouts.length) {
    listEl.innerHTML = '<p class="text-secondary">No payout requests yet.</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'table';
  table.innerHTML = `<thead><tr><th>Requested</th><th class="numeric">Amount</th><th>Method</th><th>Status</th><th>Reference</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  payouts.forEach((p) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(p.requestedAt)}</td>
      <td class="numeric">${formatPesewas(p.amountPesewas)}</td>
      <td>${p.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'}</td>
      <td>${PAYOUT_STATUS_LABELS[p.status] || p.status}</td>
      <td>${p.reference ? escapeHtml(p.reference) : '-'}</td>
    `;
    tbody.appendChild(row);
  });
  listEl.appendChild(table);
}

function wirePayoutRequest() {
  const form = document.querySelector('[data-affiliate-payout-details-form]');
  const requestBtn = document.querySelector('[data-affiliate-request-payout-btn]');
  const payoutError = document.querySelector('[data-affiliate-payout-error]');

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const method = form.querySelector('[name="method"]').value;
      const details = form.querySelector('[name="details"]').value;
      try {
        await window.CustomerDashboard.customerFetch('/api/customer/affiliates/payout-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, details }),
        });
        form.querySelector('[data-affiliate-payout-details-saved]').hidden = false;
      } catch (error) {
        payoutError.hidden = false;
        payoutError.textContent = error.message || 'Could not save your payout details.';
      }
    });
  }

  if (requestBtn) {
    requestBtn.addEventListener('click', async () => {
      requestBtn.disabled = true;
      payoutError.hidden = true;
      try {
        await window.CustomerDashboard.customerFetch('/api/customer/affiliates/payouts/request', { method: 'POST' });
        window.location.reload();
      } catch (error) {
        payoutError.hidden = false;
        payoutError.textContent = error.message || 'Could not request a payout.';
        requestBtn.disabled = false;
      }
    });
  }
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

document.addEventListener('dashboard:ready', initAffiliateEarnings);
