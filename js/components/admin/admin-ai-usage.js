/**
 * Robayer WealthLab — AI Usage admin page, Version 5.0 Milestone 1.1
 * (AI Gateway Operational Hardening). Same list/filter/pagination/
 * drawer shell as admin-orders.js, and the same dependency-free
 * inline-SVG charts (window.AdminCharts, timeseries-chart.js) already
 * used by admin-analytics.js — no new UI mechanism invented for this
 * page.
 *
 * Super-admin only, enforced server-side (routes/admin/aiUsage.ts) —
 * this script does not additionally gate anything, since reaching this
 * page at all already implies the session is a super_admin.
 */

const AI_USAGE_API_BASE = '/api/admin/ai-usage';

function initAdminAiUsage() {
  const root = document.querySelector('[data-ai-usage-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const state = {
    search: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    feature: '',
    provider: '',
    classification: '',
    page: 1,
    pageSize: 25,
    items: [],
    total: 0,
  };

  const els = {
    loadError: root.querySelector('[data-ai-usage-load-error]'),
    searchInput: root.querySelector('[data-ai-usage-search]'),
    dateFrom: root.querySelector('[data-ai-usage-date-from]'),
    dateTo: root.querySelector('[data-ai-usage-date-to]'),
    featureFilter: root.querySelector('[data-ai-usage-feature-filter]'),
    providerFilter: root.querySelector('[data-ai-usage-provider-filter]'),
    classificationFilter: root.querySelector('[data-ai-usage-classification-filter]'),
    statusChips: Array.from(root.querySelectorAll('[data-ai-usage-status-filter]')),
    resultCount: root.querySelector('[data-ai-usage-result-count]'),
    exportButton: root.querySelector('[data-ai-usage-export]'),
    emptyState: root.querySelector('[data-ai-usage-empty]'),
    emptyTitle: root.querySelector('[data-ai-usage-empty-title]'),
    emptyBody: root.querySelector('[data-ai-usage-empty-body]'),
    tableWrap: root.querySelector('[data-ai-usage-table-wrap]'),
    tableBody: root.querySelector('[data-ai-usage-table-body]'),
    pagination: root.querySelector('[data-ai-usage-pagination]'),
    paginationLabel: root.querySelector('[data-ai-usage-pagination-label]'),
    paginationPrev: root.querySelector('[data-ai-usage-pagination-prev]'),
    paginationNext: root.querySelector('[data-ai-usage-pagination-next]'),
    chartCallsPerDay: root.querySelector('[data-chart-calls-per-day]'),
    chartCostPerDay: root.querySelector('[data-chart-cost-per-day]'),
    chartTokensPerDay: root.querySelector('[data-chart-tokens-per-day]'),
    chartLatencyPerDay: root.querySelector('[data-chart-latency-per-day]'),
    chartSuccessRate: root.querySelector('[data-chart-success-rate]'),
    chartFailureRate: root.querySelector('[data-chart-failure-rate]'),
    chartCallsPerFeature: root.querySelector('[data-chart-calls-per-feature]'),
    chartCallsPerProvider: root.querySelector('[data-chart-calls-per-provider]'),
  };

  const drawer = document.querySelector('[data-ai-usage-drawer]');
  const drawerEls = {
    feature: drawer.querySelector('[data-ai-usage-drawer-feature]'),
    meta: drawer.querySelector('[data-ai-usage-drawer-meta]'),
    error: drawer.querySelector('[data-ai-usage-drawer-error]'),
    statusBadge: drawer.querySelector('[data-ai-usage-drawer-status-badge]'),
    actor: drawer.querySelector('[data-ai-usage-drawer-actor]'),
    session: drawer.querySelector('[data-ai-usage-drawer-session]'),
    sensitivity: drawer.querySelector('[data-ai-usage-drawer-sensitivity]'),
    provider: drawer.querySelector('[data-ai-usage-drawer-provider]'),
    promptVersion: drawer.querySelector('[data-ai-usage-drawer-prompt-version]'),
    fallback: drawer.querySelector('[data-ai-usage-drawer-fallback]'),
    tokens: drawer.querySelector('[data-ai-usage-drawer-tokens]'),
    cost: drawer.querySelector('[data-ai-usage-drawer-cost]'),
    duration: drawer.querySelector('[data-ai-usage-drawer-duration]'),
    classification: drawer.querySelector('[data-ai-usage-drawer-classification]'),
    errorRow: drawer.querySelector('[data-ai-usage-drawer-error-row]'),
    errorMessage: drawer.querySelector('[data-ai-usage-drawer-error-message]'),
    promptText: drawer.querySelector('[data-ai-usage-drawer-prompt-text]'),
    responseText: drawer.querySelector('[data-ai-usage-drawer-response-text]'),
    gatewayVersion: drawer.querySelector('[data-ai-usage-drawer-gateway-version]'),
    policyVersion: drawer.querySelector('[data-ai-usage-drawer-policy-version]'),
    providerDecision: drawer.querySelector('[data-ai-usage-drawer-provider-decision]'),
    budgetDecision: drawer.querySelector('[data-ai-usage-drawer-budget-decision]'),
    retentionDecision: drawer.querySelector('[data-ai-usage-drawer-retention-decision]'),
    masking: drawer.querySelector('[data-ai-usage-drawer-masking]'),
    cleanupEligible: drawer.querySelector('[data-ai-usage-drawer-cleanup-eligible]'),
    purgedAt: drawer.querySelector('[data-ai-usage-drawer-purged-at]'),
  };

  bindToolbar();
  bindDrawer();
  loadAnalytics();
  refresh();

  async function loadAnalytics() {
    try {
      const analytics = await window.AdminAuth.adminFetch(`${AI_USAGE_API_BASE}/analytics?days=30`);
      window.AdminCharts.renderTimeseries(els.chartCallsPerDay, analytics.callsPerDay, { color: 'var(--color-accent)' });
      window.AdminCharts.renderTimeseries(els.chartCostPerDay, analytics.costPerDayUsdMicros.map((p) => ({ date: p.date, count: Math.round((p.count / 1_000_000) * 10000) / 10000 })), {
        color: 'var(--color-sika-gold)',
      });
      window.AdminCharts.renderTimeseries(els.chartTokensPerDay, analytics.tokensPerDay, { color: 'var(--color-accent)' });
      window.AdminCharts.renderTimeseries(els.chartLatencyPerDay, analytics.avgLatencyPerDayMs, { color: 'var(--color-info)' });
      window.AdminCharts.renderTimeseries(els.chartSuccessRate, analytics.successRatePerDayPercent, { color: 'var(--color-success)' });
      window.AdminCharts.renderTimeseries(
        els.chartFailureRate,
        analytics.successRatePerDayPercent.map((p) => ({ date: p.date, count: Math.round((100 - p.count) * 10) / 10 })),
        { color: 'var(--color-error)' }
      );
      window.AdminCharts.renderBarChart(els.chartCallsPerFeature, analytics.callsPerFeature.map((f) => ({ label: f.label, value: f.value })), { color: 'var(--color-accent)' });
      window.AdminCharts.renderBarChart(els.chartCallsPerProvider, analytics.callsPerProvider.map((p) => ({ label: p.label, value: p.value })), { color: 'var(--color-sika-gold)' });

      populateFilterOptions(els.featureFilter, analytics.callsPerFeature.map((f) => f.label));
      populateFilterOptions(els.providerFilter, analytics.callsPerProvider.map((p) => p.label));
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load AI usage analytics.';
      els.loadError.hidden = false;
    }
  }

  function populateFilterOptions(selectEl, values) {
    const current = selectEl.value;
    Array.from(selectEl.querySelectorAll('option[data-dynamic]')).forEach((opt) => opt.remove());
    values.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.setAttribute('data-dynamic', 'true');
      selectEl.appendChild(option);
    });
    if (values.includes(current)) selectEl.value = current;
  }

  async function refresh() {
    els.loadError.hidden = true;
    try {
      const result = await window.AdminAuth.adminFetch(`${AI_USAGE_API_BASE}?${buildQuery().toString()}`);
      state.items = result.items;
      state.total = result.total;
      renderTable();
      renderPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load the AI usage log.';
      els.loadError.hidden = false;
    }
  }

  function buildQuery() {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.status) params.set('status', state.status);
    if (state.dateFrom) params.set('dateFrom', state.dateFrom);
    if (state.dateTo) params.set('dateTo', state.dateTo);
    if (state.feature) params.set('feature', state.feature);
    if (state.provider) params.set('provider', state.provider);
    if (state.classification) params.set('classification', state.classification);
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    return params;
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
    els.featureFilter.addEventListener('change', () => {
      state.feature = els.featureFilter.value;
      state.page = 1;
      refresh();
    });
    els.providerFilter.addEventListener('change', () => {
      state.provider = els.providerFilter.value;
      state.page = 1;
      refresh();
    });
    els.classificationFilter.addEventListener('change', () => {
      state.classification = els.classificationFilter.value;
      state.page = 1;
      refresh();
    });

    els.statusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state.status = chip.getAttribute('data-ai-usage-status-filter');
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

    els.exportButton.addEventListener('click', () => {
      // A plain top-level navigation, not fetch()+blob — the session
      // cookie rides along automatically (same-origin GET), and the
      // response's Content-Disposition: attachment header triggers a
      // native browser download without leaving this page.
      window.location.href = `${AI_USAGE_API_BASE}/export?${buildQuery().toString()}`;
    });
  }

  function syncChips() {
    els.statusChips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.getAttribute('data-ai-usage-status-filter') === state.status));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    els.paginationLabel.textContent = `Page ${state.page} of ${totalPages}`;
    els.paginationPrev.disabled = state.page <= 1;
    els.paginationNext.disabled = state.page >= totalPages;
    els.resultCount.textContent = state.total === 1 ? '1 call' : `${state.total} calls`;
  }

  function renderTable() {
    els.tableBody.innerHTML = '';
    const hasItems = state.items.length > 0;
    els.emptyState.hidden = hasItems;
    els.tableWrap.hidden = !hasItems;
    els.pagination.hidden = !hasItems;
    const filtered = state.search || state.status || state.dateFrom || state.dateTo || state.feature || state.provider;
    if (filtered) {
      els.emptyTitle.textContent = 'No calls match these filters';
      els.emptyBody.textContent = 'Try a different search or clear the filters above.';
    } else {
      els.emptyTitle.textContent = 'No AI Gateway calls yet';
      els.emptyBody.textContent = 'Once a feature calls the AI Gateway, every call appears here.';
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

    const tsCell = document.createElement('td');
    tsCell.textContent = formatDateTime(item.createdAt);

    const actorCell = document.createElement('td');
    actorCell.textContent = item.actorLabel;

    const featureCell = document.createElement('td');
    featureCell.textContent = item.feature;
    if (item.fallbackUsed) {
      const fallbackBadge = document.createElement('span');
      fallbackBadge.className = 'badge badge--info';
      fallbackBadge.style.marginLeft = 'var(--space-2)';
      fallbackBadge.textContent = 'Fallback';
      featureCell.appendChild(fallbackBadge);
    }

    const classificationCell = document.createElement('td');
    classificationCell.textContent = item.sensitivityClassification;

    const providerCell = document.createElement('td');
    providerCell.textContent = `${item.provider} / ${item.model}`;

    const tokensCell = document.createElement('td');
    tokensCell.textContent = `${item.totalTokens} (${item.tokensIn} in / ${item.tokensOut} out)`;

    const costCell = document.createElement('td');
    costCell.textContent = formatUsdMicros(item.costUsdMicros);

    const durationCell = document.createElement('td');
    durationCell.textContent = `${item.latencyMs}ms`;

    const statusCell = document.createElement('td');
    statusCell.appendChild(statusBadge(item.succeeded));

    row.append(tsCell, actorCell, featureCell, classificationCell, providerCell, tokensCell, costCell, durationCell, statusCell);
    return row;
  }

  function statusBadge(succeeded) {
    const badge = document.createElement('span');
    updateStatusBadge(badge, succeeded);
    return badge;
  }

  function updateStatusBadge(badge, succeeded) {
    badge.className = `badge ${succeeded ? 'badge--success' : 'badge--error'}`;
    badge.textContent = succeeded ? 'Succeeded' : 'Failed';
  }

  function bindDrawer() {
    drawer.querySelectorAll('[data-drawer-close]').forEach((btn) => btn.addEventListener('click', closeDrawer));
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
    });
  }

  async function openDrawer(id) {
    drawerEls.error.hidden = true;
    drawer.returnFocusTo = document.activeElement;
    drawer.hidden = false;
    drawerEls.feature.textContent = 'Loading…';
    try {
      const detail = await window.AdminAuth.adminFetch(`${AI_USAGE_API_BASE}/${encodeURIComponent(id)}`);
      renderDrawer(detail);
      drawerEls.feature.focus();
    } catch (error) {
      drawerEls.error.textContent = error.message || 'Could not load this AI usage record.';
      drawerEls.error.hidden = false;
    }
  }

  function closeDrawer() {
    drawer.hidden = true;
    if (drawer.returnFocusTo && document.contains(drawer.returnFocusTo)) drawer.returnFocusTo.focus();
    drawer.returnFocusTo = null;
  }

  function renderDrawer(detail) {
    drawerEls.feature.textContent = detail.feature;
    drawerEls.meta.textContent = formatDateTime(detail.createdAt);
    updateStatusBadge(drawerEls.statusBadge, detail.succeeded);
    drawerEls.actor.textContent = detail.actorLabel;
    drawerEls.session.textContent = detail.sessionId === null ? 'None' : String(detail.sessionId);
    drawerEls.sensitivity.textContent = detail.sensitivityClassification;
    drawerEls.provider.textContent = `${detail.provider} / ${detail.model}`;
    drawerEls.promptVersion.textContent = detail.promptKey ? `${detail.promptKey} v${detail.promptVersion}` : 'Not a stored prompt';
    drawerEls.fallback.textContent = detail.fallbackUsed ? 'Yes' : 'No';
    drawerEls.tokens.textContent = `${detail.totalTokens} total (${detail.tokensIn} in / ${detail.tokensOut} out)`;
    drawerEls.cost.textContent = formatUsdMicros(detail.costUsdMicros);
    drawerEls.duration.textContent = `${detail.latencyMs}ms`;
    drawerEls.classification.textContent = detail.dataClassification;
    drawerEls.errorRow.hidden = !detail.errorMessage;
    drawerEls.errorMessage.textContent = detail.errorMessage || '';
    drawerEls.promptText.textContent = detail.promptText || '(not recorded)';
    drawerEls.responseText.textContent = detail.responseText || '(no response — call did not succeed)';

    drawerEls.gatewayVersion.textContent = detail.gatewayVersion || 'Unknown';
    drawerEls.policyVersion.textContent = detail.policyVersion || 'Unknown';
    drawerEls.providerDecision.textContent = detail.providerDecision || 'Not recorded';
    drawerEls.budgetDecision.textContent = detail.budgetDecision || 'Not recorded';
    drawerEls.retentionDecision.textContent = detail.retentionDecision || 'Not recorded';
    drawerEls.masking.textContent = detail.maskingApplied ? 'Yes — a recognizable secret pattern was detected' : 'No';
    drawerEls.cleanupEligible.textContent = detail.cleanupEligibleDate ? formatDateTime(detail.cleanupEligibleDate) : 'Not applicable (nothing stored, or retained forever)';
    drawerEls.purgedAt.textContent = detail.purgedAt ? formatDateTime(detail.purgedAt) : 'Not yet purged';
  }
}

function formatUsdMicros(micros) {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function formatDateTime(isoString) {
  const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
  return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

document.addEventListener('partials:loaded', initAdminAiUsage);
