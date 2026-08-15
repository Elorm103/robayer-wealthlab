/**
 * Robayer WealthLab — Advertising Spend admin page (P0-B, Business
 * Intelligence backbone, first component).
 *
 * Same adminFetch()/pagination conventions as admin-coupons.js. Unlike
 * every other money field in this admin (which is always GHS pesewas),
 * amounts here can be in any currency, so this page never uses a
 * hardcoded "GH₵" formatter — amountMinorUnits is always displayed
 * alongside its own stored currency code, never converted.
 */

const AD_SPEND_API_BASE = '/api/admin/ad-spend';

function initAdminAdSpend() {
  const root = document.querySelector('[data-ad-spend-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    page: 1,
    pageSize: 20,
    items: [],
    total: 0,
  };

  const els = {
    loadError: root.querySelector('[data-ad-spend-load-error]'),
    actionSuccess: root.querySelector('[data-ad-spend-action-success]'),
    resultCount: root.querySelector('[data-ad-spend-result-count]'),
    newToggle: root.querySelector('[data-ad-spend-new-toggle]'),
    newCancel: root.querySelector('[data-ad-spend-new-cancel]'),
    formPanel: root.querySelector('[data-ad-spend-form-panel]'),
    form: root.querySelector('[data-ad-spend-form]'),
    formError: root.querySelector('[data-ad-spend-form-error]'),
    emptyState: root.querySelector('[data-ad-spend-empty]'),
    tableWrap: root.querySelector('[data-ad-spend-table-wrap]'),
    tableBody: root.querySelector('[data-ad-spend-table-body]'),
    pagination: root.querySelector('[data-ad-spend-pagination]'),
    paginationLabel: root.querySelector('[data-ad-spend-pagination-label]'),
    paginationPrev: root.querySelector('[data-ad-spend-pagination-prev]'),
    paginationNext: root.querySelector('[data-ad-spend-pagination-next]'),
  };

  bindForm();
  bindPagination();
  refresh();

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

      const entryDate = els.form.querySelector('#ad-spend-date').value;
      const source = els.form.querySelector('#ad-spend-source').value;
      const campaignLabel = els.form.querySelector('#ad-spend-campaign').value.trim();
      const amountRaw = els.form.querySelector('#ad-spend-amount').value;
      const currency = els.form.querySelector('#ad-spend-currency').value.trim().toUpperCase();
      const notes = els.form.querySelector('#ad-spend-notes').value.trim();

      const amount = Number(amountRaw);
      if (!entryDate || !campaignLabel || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
        els.formError.textContent = 'Date, campaign label, a non-negative amount, and a 3-letter currency code are required.';
        els.formError.hidden = false;
        return;
      }

      const submitButton = els.form.querySelector('[type="submit"]');
      submitButton.disabled = true;

      try {
        await window.AdminAuth.adminFetch(AD_SPEND_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entryDate,
            source,
            campaignLabel,
            // Minor units — same "smallest currency unit" convention as
            // every price in this codebase, computed here since the
            // form collects a human decimal amount.
            amountMinorUnits: Math.round(amount * 100),
            currency,
            notes: notes || null,
          }),
        });
        els.form.reset();
        els.formPanel.hidden = true;
        els.newToggle.hidden = false;
        els.actionSuccess.textContent = 'Spend entry saved.';
        els.actionSuccess.hidden = false;
        state.page = 1;
        refresh();
      } catch (error) {
        els.formError.textContent = error.message || 'Could not save this spend entry.';
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

      const result = await window.AdminAuth.adminFetch(`${AD_SPEND_API_BASE}?${params.toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load spend entries.';
      els.loadError.hidden = false;
    }
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 entry' : `${state.total} entries`;
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

  function buildRow(item) {
    const row = document.createElement('tr');

    const dateCell = document.createElement('td');
    dateCell.textContent = item.entryDate;

    const sourceCell = document.createElement('td');
    sourceCell.appendChild(sourceBadge(item.source));

    const campaignCell = document.createElement('td');
    campaignCell.textContent = item.campaignLabel;

    const amountCell = document.createElement('td');
    amountCell.style.fontFamily = 'var(--font-mono)';
    amountCell.textContent = formatMinorUnits(item.amountMinorUnits, item.currency);

    const notesCell = document.createElement('td');
    notesCell.className = 'text-secondary text-small';
    notesCell.textContent = item.notes || '—';

    const actionsCell = document.createElement('td');
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn--secondary';
    deleteButton.style.cssText = 'padding:6px 12px;font-size:var(--text-small);';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteEntry(item.id));
    actionsCell.appendChild(deleteButton);

    row.append(dateCell, sourceCell, campaignCell, amountCell, notesCell, actionsCell);
    return row;
  }

  function sourceBadge(source) {
    const badge = document.createElement('span');
    const variants = { meta: 'badge--info', google: 'badge--success', linkedin: 'badge--info', other: 'badge--warning' };
    badge.className = `badge ${variants[source] || 'badge--info'}`;
    badge.textContent = source.charAt(0).toUpperCase() + source.slice(1);
    return badge;
  }

  async function deleteEntry(id) {
    if (!window.confirm('Remove this spend entry? It will be hidden from this list but kept on record.')) return;
    els.loadError.hidden = true;
    els.actionSuccess.hidden = true;
    try {
      await window.AdminAuth.adminFetch(`${AD_SPEND_API_BASE}/${id}`, { method: 'DELETE' });
      els.actionSuccess.textContent = 'Spend entry removed.';
      els.actionSuccess.hidden = false;
      refresh();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not remove this spend entry.';
      els.loadError.hidden = false;
    }
  }
}

/** Never assumes GHS — every other money formatter in this admin (formatPesewas) is GHS-only by design; this ledger holds any currency, so the code always travels with the number. */
function formatMinorUnits(minorUnits, currency) {
  const major = Math.round(minorUnits) / 100;
  const withSeparators = major.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${withSeparators}`;
}

document.addEventListener('partials:loaded', initAdminAdSpend);
