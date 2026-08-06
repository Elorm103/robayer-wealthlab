/**
 * Robayer WealthLab — Knowledge Base admin page, Version 5.0
 * Milestone 2, extended in Milestone 2.2 with a per-result score
 * breakdown, search analytics, embedding version tracking, and dead
 * letter queue visibility. Same list/filter/pagination shell as
 * admin-ai-usage.js.
 *
 * Super-admin only, enforced server-side (routes/admin/knowledgeBase.ts).
 */

const KB_API_BASE = '/api/admin/knowledge-base';

const STATUS_BADGE = {
  healthy: { label: 'Healthy', variant: 'badge--success' },
  warning: { label: 'Warning', variant: 'badge--warning' },
  critical: { label: 'Critical', variant: 'badge--error' },
};

const DOC_STATUS_BADGE = {
  indexed: 'badge--success',
  pending: 'badge--warning',
  failed: 'badge--error',
};

function initAdminKnowledgeBase() {
  const root = document.querySelector('[data-kb-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const docState = { status: '', sourceType: '', search: '', page: 1, pageSize: 25, total: 0 };

  const els = {
    loadError: root.querySelector('[data-kb-load-error]'),
    healthBadge: root.querySelector('[data-kb-health-badge]'),
    healthReason: root.querySelector('[data-kb-health-reason]'),
    indexedCount: root.querySelector('[data-kb-indexed-count]'),
    pendingCount: root.querySelector('[data-kb-pending-count]'),
    failedCount: root.querySelector('[data-kb-failed-count]'),
    totalCount: root.querySelector('[data-kb-total-count]'),
    lastRun: root.querySelector('[data-kb-last-run]'),
    storageStats: root.querySelector('[data-kb-storage-stats]'),
    embeddingStats: root.querySelector('[data-kb-embedding-stats]'),
    searchStats: root.querySelector('[data-kb-search-stats]'),
    embeddingVersions: root.querySelector('[data-kb-embedding-versions]'),
    reindexButton: root.querySelector('[data-kb-reindex]'),
    rebuildButton: root.querySelector('[data-kb-rebuild]'),
    runStatus: root.querySelector('[data-kb-run-status]'),
    searchInput: root.querySelector('[data-kb-search-input]'),
    searchButton: root.querySelector('[data-kb-search-button]'),
    searchError: root.querySelector('[data-kb-search-error]'),
    searchMeta: root.querySelector('[data-kb-search-meta]'),
    searchResults: root.querySelector('[data-kb-search-results]'),
    docSearch: root.querySelector('[data-kb-doc-search]'),
    docSourceFilter: root.querySelector('[data-kb-doc-source-filter]'),
    docStatusChips: Array.from(root.querySelectorAll('[data-kb-doc-status-filter]')),
    docResultCount: root.querySelector('[data-kb-doc-result-count]'),
    docEmpty: root.querySelector('[data-kb-doc-empty]'),
    docTableWrap: root.querySelector('[data-kb-doc-table-wrap]'),
    docTableBody: root.querySelector('[data-kb-doc-table-body]'),
    docPagination: root.querySelector('[data-kb-doc-pagination]'),
    docPaginationLabel: root.querySelector('[data-kb-doc-pagination-label]'),
    docPaginationPrev: root.querySelector('[data-kb-doc-pagination-prev]'),
    docPaginationNext: root.querySelector('[data-kb-doc-pagination-next]'),
    runsTableBody: root.querySelector('[data-kb-runs-table-body]'),
    analyticsTotal: root.querySelector('[data-kb-analytics-total]'),
    analyticsSuccessRate: root.querySelector('[data-kb-analytics-success-rate]'),
    analyticsAvgConfidence: root.querySelector('[data-kb-analytics-avg-confidence]'),
    analyticsLatency: root.querySelector('[data-kb-analytics-latency]'),
    analyticsConfidenceDist: root.querySelector('[data-kb-analytics-confidence-dist]'),
    analyticsTrend: root.querySelector('[data-kb-analytics-trend]'),
    analyticsCommon: root.querySelector('[data-kb-analytics-common]'),
    analyticsZeroResult: root.querySelector('[data-kb-analytics-zero-result]'),
    analyticsTopDocs: root.querySelector('[data-kb-analytics-top-docs]'),
    dlqEmpty: root.querySelector('[data-kb-dlq-empty]'),
    dlqTableWrap: root.querySelector('[data-kb-dlq-table-wrap]'),
    dlqTableBody: root.querySelector('[data-kb-dlq-table-body]'),
  };

  bindToolbar();
  loadStatus();
  loadDocuments();
  loadRuns();
  loadEmbeddingVersions();
  loadSearchAnalytics();
  loadDeadLetters();

  async function loadStatus() {
    els.loadError.hidden = true;
    try {
      const status = await window.AdminAuth.adminFetch(`${KB_API_BASE}/status`);
      renderStatus(status);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load Knowledge Base status.';
      els.loadError.hidden = false;
    }
  }

  function renderStatus(status) {
    const badge = STATUS_BADGE[status.health] || STATUS_BADGE.warning;
    els.healthBadge.className = `badge ${badge.variant}`;
    els.healthBadge.textContent = badge.label;
    els.healthReason.textContent = status.healthReason;

    els.indexedCount.textContent = String(status.indexedCount);
    els.pendingCount.textContent = String(status.pendingCount);
    els.failedCount.textContent = String(status.failedCount);
    els.totalCount.textContent = String(status.totalDocuments);

    if (status.lastRun) {
      els.lastRun.innerHTML = [
        diagnosticRow('Run type', labelize(status.lastRun.runType)),
        diagnosticRow('Status', labelize(status.lastRun.status)),
        diagnosticRow('Started', formatDateTime(status.lastRun.startedAt)),
        diagnosticRow('Completed', status.lastRun.completedAt ? formatDateTime(status.lastRun.completedAt) : 'Still running'),
        diagnosticRow('Documents seen / indexed / unchanged / failed', `${status.lastRun.documentsSeen} / ${status.lastRun.documentsIndexed} / ${status.lastRun.documentsUnchanged} / ${status.lastRun.documentsFailed}`),
        diagnosticRow('Chunks created', String(status.lastRun.chunksCreated)),
      ].join('');
    } else {
      els.lastRun.innerHTML = diagnosticRow('Run type', 'No run has ever been performed');
    }

    els.storageStats.innerHTML = [
      diagnosticRow('Total chunks', String(status.storageStats.totalChunks)),
      diagnosticRow('Documents with chunks', String(status.storageStats.totalDocumentsWithChunks)),
      diagnosticRow('Average chunks / document', status.storageStats.avgChunksPerDocument === null ? 'No data yet' : String(status.storageStats.avgChunksPerDocument)),
    ].join('');

    els.embeddingStats.innerHTML = [
      diagnosticRow('Embedding calls', String(status.embeddingStats.callCount30d)),
      diagnosticRow('Embedding cost', formatUsdMicros(status.embeddingStats.costUsdMicros30d)),
      diagnosticRow('Embedding model', status.embeddingStats.embeddingModel || 'No data yet'),
    ].join('');

    els.searchStats.innerHTML = [
      diagnosticRow('Searches run', String(status.searchStats.searchCount30d)),
      diagnosticRow('Average latency', status.searchStats.avgLatencyMs30d === null ? 'No data yet' : `${status.searchStats.avgLatencyMs30d}ms`),
      diagnosticRow('Average top score', status.searchStats.avgTopScore30d === null ? 'No data yet' : String(status.searchStats.avgTopScore30d)),
      diagnosticRow('Low-confidence result rate', status.searchStats.lowConfidenceRatio30d === null ? 'No data yet' : `${status.searchStats.lowConfidenceRatio30d}%`),
    ].join('');
  }

  function diagnosticRow(label, value) {
    return `<div class="settings-diagnostic-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  }

  function bindToolbar() {
    els.reindexButton.addEventListener('click', () => triggerRun('reindex', els.reindexButton));
    els.rebuildButton.addEventListener('click', () => {
      if (!window.confirm('Full rebuild re-processes every document regardless of whether its content has changed. This makes real embedding calls for every single document. Continue?')) return;
      triggerRun('rebuild', els.rebuildButton);
    });

    els.searchButton.addEventListener('click', runSearchTest);
    els.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearchTest();
    });

    let searchTimer = null;
    els.docSearch.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        docState.search = els.docSearch.value.trim();
        docState.page = 1;
        loadDocuments();
      }, 300);
    });
    els.docSourceFilter.addEventListener('change', () => {
      docState.sourceType = els.docSourceFilter.value;
      docState.page = 1;
      loadDocuments();
    });
    els.docStatusChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        docState.status = chip.getAttribute('data-kb-doc-status-filter');
        docState.page = 1;
        els.docStatusChips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        loadDocuments();
      });
    });
    els.docPaginationPrev.addEventListener('click', () => {
      if (docState.page > 1) {
        docState.page -= 1;
        loadDocuments();
      }
    });
    els.docPaginationNext.addEventListener('click', () => {
      if (docState.page * docState.pageSize < docState.total) {
        docState.page += 1;
        loadDocuments();
      }
    });
  }

  async function triggerRun(kind, button) {
    button.disabled = true;
    els.runStatus.textContent = 'Starting…';
    try {
      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/${kind === 'reindex' ? 'reindex' : 'rebuild'}`, { method: 'POST' });
      els.runStatus.textContent = `Started (${result.runType}) — running in the background. Refresh in a moment to see progress.`;
      window.setTimeout(() => {
        loadStatus();
        loadRuns();
      }, 4000);
    } catch (error) {
      els.runStatus.textContent = error.message || 'Could not start the run.';
    } finally {
      button.disabled = false;
    }
  }

  async function runSearchTest() {
    const query = els.searchInput.value.trim();
    els.searchError.hidden = true;
    els.searchMeta.hidden = true;
    if (!query) return;

    els.searchButton.disabled = true;
    els.searchResults.innerHTML = '';
    try {
      // Version 5.0 Milestone 2.2 refinement pass — the diagnostics tool
      // requests the maximum allowed limit (20, vs. the 5 a real caller
      // would typically use) so an admin investigating a retrieval gap
      // sees the full candidate pool Vectorize actually returned
      // (topK = limit * 4 in searchService.ts), not just the top 5.
      // This is a measurement/diagnostic-breadth change only — it does
      // not alter ranking logic or the topK formula itself.
      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/search-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, visibility: 'public', limit: 20 }),
      });
      els.searchMeta.hidden = false;
      els.searchMeta.textContent = `${result.results.length} result(s) in ${result.latencyMs}ms.`;
      renderSearchResults(result.results);
      // Version 5.0 Milestone 2.2 refinement pass — loadSearchAnalytics()
      // was previously only called once, on page load, so a new
      // diagnostic search never updated Total Searches/Most Retrieved
      // Documents/etc. until a manual page reload. Every real search
      // this function runs writes to knowledge_search_log, so refresh
      // the analytics panel right after, same as the run-status polling
      // does after triggering a reindex.
      loadSearchAnalytics();
    } catch (error) {
      els.searchError.textContent = error.message || 'Search failed.';
      els.searchError.hidden = false;
    } finally {
      els.searchButton.disabled = false;
    }
  }

  const CONFIDENCE_BADGE = { high: 'badge--success', medium: 'badge--warning', low: 'badge--error' };

  /** Version 5.0 Milestone 2.2, Task 3 — shows exactly why a result ranked where it did: vector similarity, each boost, and the final blended score, not just the final number. */
  function renderSearchResults(results) {
    if (results.length === 0) {
      els.searchResults.innerHTML = '<p class="text-small text-secondary">No results.</p>';
      return;
    }
    els.searchResults.innerHTML = results
      .map(
        (r) => `
      <div class="drawer__note mb-2">
        <p class="drawer__note-meta">
          <span class="badge ${CONFIDENCE_BADGE[r.confidence] || 'badge--info'}">${r.confidence}</span>
          final score ${r.score.toFixed(3)} · ${escapeHtml(labelize(r.sourceType))} ·
          ${r.sourceUrl ? `<a href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(r.sourceTitle)}</a>` : escapeHtml(r.sourceTitle)}
        </p>
        <p class="text-small text-secondary">
          vector similarity ${r.vectorSimilarity.toFixed(3)}
          &middot; title boost +${r.titleBoost.toFixed(3)}
          &middot; keyword boost +${r.keywordBoost.toFixed(3)}
          &middot; source boost +${r.sourceBoost.toFixed(3)}
          &middot; final ${r.score.toFixed(3)} &rarr; <strong>${r.confidence}</strong>
        </p>
        <p>${escapeHtml(r.chunkText.slice(0, 300))}${r.chunkText.length > 300 ? '…' : ''}</p>
      </div>
    `
      )
      .join('');
  }

  async function loadDocuments() {
    try {
      const params = new URLSearchParams();
      if (docState.status) params.set('status', docState.status);
      if (docState.sourceType) params.set('sourceType', docState.sourceType);
      if (docState.search) params.set('search', docState.search);
      params.set('page', String(docState.page));
      params.set('pageSize', String(docState.pageSize));

      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/documents?${params.toString()}`);
      docState.total = result.total;
      renderDocuments(result.items);
      renderDocPagination();
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load documents.';
      els.loadError.hidden = false;
    }
  }

  function renderDocPagination() {
    const totalPages = Math.max(1, Math.ceil(docState.total / docState.pageSize));
    els.docPaginationLabel.textContent = `Page ${docState.page} of ${totalPages}`;
    els.docPaginationPrev.disabled = docState.page <= 1;
    els.docPaginationNext.disabled = docState.page >= totalPages;
    els.docResultCount.textContent = docState.total === 1 ? '1 document' : `${docState.total} documents`;
  }

  function renderDocuments(items) {
    els.docTableBody.innerHTML = '';
    const hasItems = items.length > 0;
    els.docEmpty.hidden = hasItems;
    els.docTableWrap.hidden = !hasItems;
    els.docPagination.hidden = !hasItems;
    if (!hasItems) return;

    items.forEach((item) => {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      if (item.sourceUrl) {
        const link = document.createElement('a');
        link.href = item.sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = item.title;
        titleCell.appendChild(link);
      } else {
        titleCell.textContent = item.title;
      }
      if (item.errorMessage) {
        const err = document.createElement('p');
        err.className = 'text-small text-secondary';
        err.textContent = item.errorMessage;
        titleCell.appendChild(err);
      }

      const sourceCell = document.createElement('td');
      sourceCell.textContent = labelize(item.sourceType);

      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${DOC_STATUS_BADGE[item.status] || 'badge--info'}`;
      badge.textContent = labelize(item.status);
      statusCell.appendChild(badge);

      const chunksCell = document.createElement('td');
      chunksCell.textContent = String(item.chunkCount);

      const versionCell = document.createElement('td');
      versionCell.textContent = String(item.version);

      const embeddingCell = document.createElement('td');
      embeddingCell.className = 'text-small';
      embeddingCell.textContent = item.embeddingModel ? `${item.embeddingModel} (${item.embeddingVersion || '—'})` : 'Not yet embedded';

      const indexedCell = document.createElement('td');
      indexedCell.textContent = item.indexedAt ? formatDateTime(item.indexedAt) : 'Never';

      row.append(titleCell, sourceCell, statusCell, chunksCell, versionCell, embeddingCell, indexedCell);
      els.docTableBody.appendChild(row);
    });
  }

  async function loadRuns() {
    try {
      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/runs?page=1&pageSize=10`);
      renderRuns(result.items);
    } catch (error) {
      // Non-fatal — the dashboard's own load error already covers the primary status call.
    }
  }

  function renderRuns(items) {
    els.runsTableBody.innerHTML = '';
    if (items.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="8">No indexing runs yet.</td>';
      els.runsTableBody.appendChild(row);
      return;
    }
    items.forEach((run) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${formatDateTime(run.startedAt)}</td>
        <td>${labelize(run.runType)}</td>
        <td><span class="badge ${DOC_STATUS_BADGE[run.status === 'completed' ? 'indexed' : run.status === 'failed' ? 'failed' : 'pending'] || 'badge--info'}">${labelize(run.status)}</span></td>
        <td>${run.documentsSeen}</td>
        <td>${run.documentsIndexed}</td>
        <td>${run.documentsUnchanged}</td>
        <td>${run.documentsFailed}</td>
        <td>${run.chunksCreated}</td>
      `;
      els.runsTableBody.appendChild(row);
    });
  }

  /** Version 5.0 Milestone 2.2, Task 5. */
  async function loadEmbeddingVersions() {
    try {
      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/embedding-versions`);
      if (result.groups.length === 0) {
        els.embeddingVersions.innerHTML = diagnosticRow('Embedding versions', 'No documents indexed yet');
        return;
      }
      els.embeddingVersions.innerHTML = result.groups
        .map((g) =>
          diagnosticRow(
            `${g.embeddingModel || 'Unknown model'} (${g.embeddingVersion || 'unknown version'})`,
            `${g.documentCount} document(s) &middot; oldest embedded ${g.oldestEmbeddedAt ? formatDateTime(g.oldestEmbeddedAt) : '—'}`
          )
        )
        .join('');
    } catch (error) {
      els.embeddingVersions.innerHTML = diagnosticRow('Embedding versions', 'Could not load');
    }
  }

  /** Version 5.0 Milestone 2.2, Task 4. */
  async function loadSearchAnalytics() {
    try {
      const a = await window.AdminAuth.adminFetch(`${KB_API_BASE}/search-analytics`);
      els.analyticsTotal.textContent = String(a.totalSearches);
      els.analyticsSuccessRate.textContent = a.searchSuccessRate === null ? '—' : `${a.searchSuccessRate}%`;
      els.analyticsAvgConfidence.textContent = a.avgConfidenceScore === null ? '—' : String(a.avgConfidenceScore);
      els.analyticsLatency.textContent =
        a.latencyMs.p50 === null ? '—' : `${a.latencyMs.p50}ms / ${a.latencyMs.p95}ms / ${a.latencyMs.max}ms`;

      const dist = a.confidenceDistribution;
      const distTotal = dist.high + dist.medium + dist.low + dist.none || 1;
      els.analyticsConfidenceDist.innerHTML = [
        diagnosticRow('High', `${dist.high} (${Math.round((dist.high / distTotal) * 100)}%)`),
        diagnosticRow('Medium', `${dist.medium} (${Math.round((dist.medium / distTotal) * 100)}%)`),
        diagnosticRow('Low', `${dist.low} (${Math.round((dist.low / distTotal) * 100)}%)`),
        diagnosticRow('Zero-result', `${dist.none} (${Math.round((dist.none / distTotal) * 100)}%)`),
      ].join('');

      els.analyticsTrend.innerHTML =
        a.lowConfidenceTrend.length === 0
          ? diagnosticRow('Last 14 days', 'No searches yet')
          : a.lowConfidenceTrend.map((t) => diagnosticRow(t.date, `${t.lowConfidenceCount} / ${t.totalSearches} low-confidence`)).join('');

      els.analyticsCommon.innerHTML = a.mostCommonSearches.length
        ? a.mostCommonSearches.map((q) => `<li>${escapeHtml(q.query)} <span class="text-small text-secondary">(${q.count})</span></li>`).join('')
        : '<li class="text-small text-secondary">No searches yet</li>';

      els.analyticsZeroResult.innerHTML = a.zeroResultSearches.length
        ? a.zeroResultSearches.map((q) => `<li>${escapeHtml(q.query)} <span class="text-small text-secondary">(${q.count})</span></li>`).join('')
        : '<li class="text-small text-secondary">None — every search has returned at least one result</li>';

      els.analyticsTopDocs.innerHTML = a.mostRetrievedDocuments.length
        ? a.mostRetrievedDocuments.map((d) => `<li>${escapeHtml(d.title)} <span class="text-small text-secondary">(${d.count})</span></li>`).join('')
        : '<li class="text-small text-secondary">No searches yet</li>';
    } catch (error) {
      // Non-fatal — the primary status load error already covers the page-level failure signal.
    }
  }

  /** Version 5.0 Milestone 2.2, Task 7. */
  async function loadDeadLetters() {
    try {
      const result = await window.AdminAuth.adminFetch(`${KB_API_BASE}/dead-letters?page=1&pageSize=25`);
      renderDeadLetters(result.items);
    } catch (error) {
      // Non-fatal.
    }
  }

  function renderDeadLetters(items) {
    const hasItems = items.length > 0;
    els.dlqEmpty.hidden = hasItems;
    els.dlqTableWrap.hidden = !hasItems;
    els.dlqTableBody.innerHTML = '';
    if (!hasItems) return;

    items.forEach((item) => {
      const row = document.createElement('tr');
      const docCell = document.createElement('td');
      docCell.textContent = item.documentKey;
      const sourceCell = document.createElement('td');
      sourceCell.textContent = labelize(item.sourceType);
      const reasonCell = document.createElement('td');
      reasonCell.className = 'text-small';
      reasonCell.textContent = item.reason;
      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `badge ${item.status === 'retried' ? 'badge--success' : item.status === 'abandoned' ? 'badge--error' : 'badge--warning'}`;
      badge.textContent = labelize(item.status);
      statusCell.appendChild(badge);
      const failedCell = document.createElement('td');
      failedCell.textContent = formatDateTime(item.failedAt);
      const actionCell = document.createElement('td');
      if (item.status === 'pending') {
        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'btn btn--secondary btn--small';
        retryButton.textContent = 'Retry';
        retryButton.addEventListener('click', () => retryDeadLetter(item.id, retryButton));
        actionCell.appendChild(retryButton);
      }

      row.append(docCell, sourceCell, reasonCell, statusCell, failedCell, actionCell);
      els.dlqTableBody.appendChild(row);
    });
  }

  async function retryDeadLetter(id, button) {
    button.disabled = true;
    button.textContent = 'Retrying…';
    try {
      await window.AdminAuth.adminFetch(`${KB_API_BASE}/dead-letters/${id}/retry`, { method: 'POST' });
      loadDeadLetters();
      loadDocuments();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Retry';
      window.alert(error.message || 'Could not retry this dead letter.');
    }
  }

  function labelize(value) {
    return String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatUsdMicros(micros) {
    return `$${(micros / 1_000_000).toFixed(4)}`;
  }

  function formatDateTime(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }
}

document.addEventListener('partials:loaded', initAdminKnowledgeBase);
