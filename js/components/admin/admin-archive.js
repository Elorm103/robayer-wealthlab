/**
 * Robayer WealthLab — Archive Centre (Version 4.9 Phase 7).
 *
 * Read-only, filter-based view over every table migration 0028 gave a
 * data_classification column: Production / Internal / Development /
 * Unknown / All. Nothing on this page ever moves, duplicates, or
 * deletes a row — every control here is a query filter over the
 * `/api/admin/archive/*` endpoints (see
 * backend/services/admin/archiveService.ts), never a mutation.
 *
 * Runs after admin-shell.js's requireSession() gate, same convention
 * as every other admin page script.
 */

const ARCHIVE_API_BASE = '/api/admin/archive';

function initAdminArchive() {
  const root = document.querySelector('[data-archive-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    entities: [],
    entityKey: null,
    classification: 'ALL',
    search: '',
    offset: 0,
    limit: 25,
    total: 0,
  };

  const els = {
    loadError: root.querySelector('[data-archive-load-error]'),
    summaryBody: root.querySelector('[data-archive-summary-body]'),
    entitySelect: root.querySelector('[data-archive-entity-select]'),
    searchInput: root.querySelector('[data-archive-search]'),
    classificationChips: Array.from(root.querySelectorAll('[data-archive-classification]')),
    resultCount: root.querySelector('[data-archive-result-count]'),
    empty: root.querySelector('[data-archive-empty]'),
    tableWrap: root.querySelector('[data-archive-table-wrap]'),
    tableHead: root.querySelector('[data-archive-table-head]'),
    tableBody: root.querySelector('[data-archive-table-body]'),
    pagination: root.querySelector('[data-archive-pagination]'),
    paginationLabel: root.querySelector('[data-archive-pagination-label]'),
    paginationPrev: root.querySelector('[data-archive-pagination-prev]'),
    paginationNext: root.querySelector('[data-archive-pagination-next]'),
  };

  const drawer = document.querySelector('[data-archive-drawer]');
  const drawerEls = {
    title: drawer.querySelector('[data-archive-drawer-title]'),
    subtitle: drawer.querySelector('[data-archive-drawer-subtitle]'),
    error: drawer.querySelector('[data-archive-drawer-error]'),
    success: drawer.querySelector('[data-archive-drawer-success]'),
    evidence: drawer.querySelector('[data-archive-drawer-evidence]'),
    relatedSection: drawer.querySelector('[data-archive-drawer-related-section]'),
    related: drawer.querySelector('[data-archive-drawer-related]'),
    promoteSection: drawer.querySelector('[data-archive-drawer-promote-section]'),
    reasonInput: drawer.querySelector('[data-archive-drawer-reason]'),
    promoteButtons: Array.from(drawer.querySelectorAll('[data-archive-promote]')),
  };
  let drawerContext = null; // { entityKey, recordId }

  let searchDebounce = null;

  init();

  async function init() {
    await loadSummary();
    bindControls();
    bindDrawer();
    if (state.entityKey) loadRecords();
  }

  async function loadSummary() {
    let payload;
    try {
      payload = await window.AdminAuth.adminFetch(`${ARCHIVE_API_BASE}/summary`);
    } catch (error) {
      els.loadError.textContent = 'Could not load the classification summary: ' + error.message;
      els.loadError.hidden = false;
      return;
    }

    state.entities = payload.entities;
    renderSummary(payload.summary);
    populateEntitySelect(payload.entities);
    // Only defaults entityKey on first load - loadSummary() is also
    // called after a promotion to refresh the counts, and must never
    // reset which table the admin is currently looking at.
    if (!state.entityKey && payload.entities.length > 0) {
      state.entityKey = payload.entities[0].key;
    }
    els.entitySelect.value = state.entityKey;
  }

  function renderSummary(summary) {
    els.summaryBody.innerHTML = '';
    summary.forEach((row) => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = row.label;
      tr.appendChild(nameTd);

      ['PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'].forEach((cls) => {
        const td = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.textContent = String(row.counts[cls]);
        button.addEventListener('click', () => selectEntityAndClassification(row.key, cls));
        td.appendChild(button);
        tr.appendChild(td);
      });

      const totalTd = document.createElement('td');
      totalTd.textContent = String(row.counts.total);
      tr.appendChild(totalTd);

      els.summaryBody.appendChild(tr);
    });
  }

  function populateEntitySelect(entities) {
    els.entitySelect.innerHTML = '';
    entities.forEach((entity) => {
      const option = document.createElement('option');
      option.value = entity.key;
      option.textContent = entity.label;
      els.entitySelect.appendChild(option);
    });
  }

  function selectEntityAndClassification(entityKey, classification) {
    state.entityKey = entityKey;
    state.classification = classification;
    state.offset = 0;
    els.entitySelect.value = entityKey;
    syncClassificationChips();
    loadRecords();
    root.querySelector('[data-archive-table-wrap]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindControls() {
    els.entitySelect.addEventListener('change', () => {
      state.entityKey = els.entitySelect.value;
      state.offset = 0;
      loadRecords();
    });

    els.classificationChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.classification = chip.getAttribute('data-archive-classification');
        state.offset = 0;
        syncClassificationChips();
        loadRecords();
      });
    });

    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.search = els.searchInput.value;
        state.offset = 0;
        loadRecords();
      }, 300);
    });

    els.paginationPrev.addEventListener('click', () => {
      if (state.offset > 0) {
        state.offset = Math.max(0, state.offset - state.limit);
        loadRecords();
      }
    });
    els.paginationNext.addEventListener('click', () => {
      if (state.offset + state.limit < state.total) {
        state.offset += state.limit;
        loadRecords();
      }
    });
  }

  function syncClassificationChips() {
    els.classificationChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-archive-classification') === state.classification));
    });
  }

  async function loadRecords() {
    if (!state.entityKey) return;
    els.loadError.hidden = true;

    const params = new URLSearchParams();
    params.set('classification', state.classification);
    if (state.search) params.set('search', state.search);
    params.set('limit', String(state.limit));
    params.set('offset', String(state.offset));

    let result;
    try {
      result = await window.AdminAuth.adminFetch(`${ARCHIVE_API_BASE}/${encodeURIComponent(state.entityKey)}?${params.toString()}`);
    } catch (error) {
      els.loadError.textContent = 'Could not load records: ' + error.message;
      els.loadError.hidden = false;
      return;
    }

    state.total = result.total;
    renderResultCount();
    renderTable(result);
    renderPagination();
  }

  function renderResultCount() {
    els.resultCount.textContent = state.total === 1 ? '1 record' : state.total + ' records';
  }

  function renderTable(result) {
    const { entity, rows } = result;

    if (rows.length === 0) {
      els.empty.hidden = false;
      els.tableWrap.hidden = true;
      els.pagination.hidden = true;
      return;
    }
    els.empty.hidden = true;
    els.tableWrap.hidden = false;
    els.pagination.hidden = false;

    els.tableHead.innerHTML = '';
    const headRow = document.createElement('tr');
    const classificationTh = document.createElement('th');
    classificationTh.scope = 'col';
    classificationTh.textContent = 'Classification';
    headRow.appendChild(classificationTh);
    entity.columns.forEach((col) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = col.label;
      headRow.appendChild(th);
    });
    const actionsTh = document.createElement('th');
    actionsTh.scope = 'col';
    actionsTh.textContent = 'Actions';
    headRow.appendChild(actionsTh);
    els.tableHead.appendChild(headRow);

    // The first configured column is always this entity's own id column
    // (see backend/services/admin/archiveService.ts's ARCHIVE_ENTITIES —
    // every entry lists its id/primary-key column first), so it doubles
    // as the record identifier for the View action without a separate
    // hidden field.
    els.tableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const clsTd = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge ' + classificationBadgeClass(row.data_classification);
      badge.textContent = row.data_classification;
      clsTd.appendChild(badge);
      tr.appendChild(clsTd);

      entity.columns.forEach((col) => {
        const td = document.createElement('td');
        const value = row[col.column];
        td.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
        tr.appendChild(td);
      });

      const actionsTd = document.createElement('td');
      const viewButton = document.createElement('button');
      viewButton.type = 'button';
      viewButton.className = 'link-button';
      viewButton.textContent = 'View';
      const recordId = row[entity.columns[0].column];
      viewButton.addEventListener('click', () => openDrawer(entity.key, recordId));
      actionsTd.appendChild(viewButton);
      tr.appendChild(actionsTd);

      els.tableBody.appendChild(tr);
    });
  }

  function classificationBadgeClass(classification) {
    switch (classification) {
      case 'PRODUCTION':
        return 'badge--success';
      case 'INTERNAL':
        return 'badge--info';
      case 'DEVELOPMENT':
        return 'badge--warning';
      default:
        return 'badge--error';
    }
  }

  function renderPagination() {
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, state.total);
    els.paginationLabel.textContent = state.total === 0 ? '' : from + '–' + to + ' of ' + state.total;
    els.paginationPrev.disabled = state.offset === 0;
    els.paginationNext.disabled = state.offset + state.limit >= state.total;
  }

  // ============================================================
  // Version 4.9 Phase 8 + 10 — Record detail drawer: "View evidence",
  // "View related entities", and (only for currently-UNKNOWN records)
  // Promote to Production/Internal/Development. Every promotion is
  // audit-logged server-side (see archiveService.promoteRecord()) —
  // this page never claims success itself; it only reports what the
  // API actually did.
  // ============================================================

  function bindDrawer() {
    drawer.querySelectorAll('[data-drawer-close]').forEach((btn) => btn.addEventListener('click', closeDrawer));
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
    });
    drawerEls.promoteButtons.forEach((button) => {
      button.addEventListener('click', () => promoteCurrentRecord(button.getAttribute('data-archive-promote')));
    });
  }

  async function openDrawer(entityKey, recordId) {
    drawerContext = { entityKey, recordId };
    drawerEls.error.hidden = true;
    drawerEls.success.hidden = true;
    drawerEls.reasonInput.value = '';
    drawer.returnFocusTo = document.activeElement;
    drawer.hidden = false;
    drawerEls.title.textContent = 'Loading…';
    drawerEls.subtitle.textContent = '';
    drawerEls.evidence.innerHTML = '';
    drawerEls.related.innerHTML = '';
    drawerEls.relatedSection.hidden = true;
    drawerEls.promoteSection.hidden = true;

    await loadDrawerDetail();
  }

  async function loadDrawerDetail() {
    if (!drawerContext) return;
    let detail;
    try {
      detail = await window.AdminAuth.adminFetch(`${ARCHIVE_API_BASE}/${encodeURIComponent(drawerContext.entityKey)}/${encodeURIComponent(drawerContext.recordId)}`);
    } catch (error) {
      drawerEls.title.textContent = 'Could not load this record';
      drawerEls.error.textContent = error.message || 'Could not load this record.';
      drawerEls.error.hidden = false;
      return;
    }
    renderDrawer(detail);
  }

  function closeDrawer() {
    drawer.hidden = true;
    drawerContext = null;
    if (drawer.returnFocusTo && document.contains(drawer.returnFocusTo)) drawer.returnFocusTo.focus();
    drawer.returnFocusTo = null;
  }

  function renderDrawer(detail) {
    const { entity, record, related } = detail;
    const classification = record.data_classification;

    drawerEls.title.textContent = entity.label + ' — record ' + (record.id ?? '');
    drawerEls.subtitle.textContent = 'Classification: ' + classification;

    drawerEls.evidence.innerHTML = '';
    Object.keys(record).forEach((key) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      const value = record[key];
      dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
      drawerEls.evidence.appendChild(dt);
      drawerEls.evidence.appendChild(dd);
    });

    drawerEls.related.innerHTML = '';
    const relatedWithRows = related.filter((group) => group.rows.length > 0);
    if (relatedWithRows.length > 0) {
      drawerEls.relatedSection.hidden = false;
      relatedWithRows.forEach((group) => {
        const heading = document.createElement('p');
        heading.className = 'text-small text-secondary mt-2';
        heading.textContent = group.label + ' (' + group.rows.length + ')';
        drawerEls.related.appendChild(heading);

        const list = document.createElement('ul');
        group.rows.forEach((row) => {
          const li = document.createElement('li');
          li.textContent = '#' + row.id + ' — ' + row.classification;
          list.appendChild(li);
        });
        drawerEls.related.appendChild(list);
      });
    } else {
      drawerEls.relatedSection.hidden = true;
    }

    drawerEls.promoteSection.hidden = classification !== 'UNKNOWN';
  }

  async function promoteCurrentRecord(classification) {
    if (!drawerContext) return;
    const reason = drawerEls.reasonInput.value.trim();
    drawerEls.error.hidden = true;
    drawerEls.success.hidden = true;

    if (!reason) {
      drawerEls.error.textContent = 'A reason is required before this record can be reclassified.';
      drawerEls.error.hidden = false;
      return;
    }

    try {
      await window.AdminAuth.adminFetch(`${ARCHIVE_API_BASE}/${encodeURIComponent(drawerContext.entityKey)}/${encodeURIComponent(drawerContext.recordId)}/classification`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification, reason }),
      });
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not reclassify this record.';
      drawerEls.error.hidden = false;
      return;
    }

    drawerEls.success.textContent = 'Reclassified to ' + classification + '. Recorded in the audit trail.';
    drawerEls.success.hidden = false;
    await loadDrawerDetail();
    await loadSummary();
    await loadRecords();
  }
}

document.addEventListener('partials:loaded', initAdminArchive);
