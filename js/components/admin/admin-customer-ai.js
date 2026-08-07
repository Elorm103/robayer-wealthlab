/**
 * Robayer WealthLab — Customer AI admin analytics page, Version 5.0
 * Milestone 3, Phase 6 (Observability). Same load/render shell as
 * admin-knowledge-base.js: adminFetch on load, escape-safe DOM
 * rendering for the recent-conversations table.
 *
 * Super-admin only, enforced server-side (routes/admin/customerAi.ts).
 */

const CAI_API_BASE = '/api/admin/customer-ai';

const STATUS_BADGE = {
  answered: 'badge--success',
  declined: 'badge--warning',
  error: 'badge--error',
};

const CONFIDENCE_BADGE = {
  high: 'badge--success',
  medium: 'badge--info',
  low: 'badge--warning',
  very_low: 'badge--error',
};

function initAdminCustomerAi() {
  const root = document.querySelector('[data-cai-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-cai-load-error]'),
    total: root.querySelector('[data-cai-total]'),
    answered: root.querySelector('[data-cai-answered]'),
    declined: root.querySelector('[data-cai-declined]'),
    errors: root.querySelector('[data-cai-errors]'),
    confidenceDist: root.querySelector('[data-cai-confidence-dist]'),
    feedback: root.querySelector('[data-cai-feedback]'),
    latencyRetrieval: root.querySelector('[data-cai-latency-retrieval]'),
    latencyLlm: root.querySelector('[data-cai-latency-llm]'),
    latencyTotal: root.querySelector('[data-cai-latency-total]'),
    latencyP95: root.querySelector('[data-cai-latency-p95]'),
    recentBody: root.querySelector('[data-cai-recent-body]'),
  };

  loadAnalytics();

  async function loadAnalytics() {
    els.loadError.hidden = true;
    try {
      const analytics = await window.AdminAuth.adminFetch(`${CAI_API_BASE}/analytics`);
      renderOverview(analytics);
      renderConfidenceDist(analytics.confidenceDistribution, analytics.totalMessages);
      renderFeedback(analytics.feedback);
      renderLatency(analytics.latencyMs);
      renderRecent(analytics.recentMessages);
    } catch (error) {
      els.loadError.textContent = error.message || 'Could not load Customer AI analytics.';
      els.loadError.hidden = false;
    }
  }

  function renderOverview(a) {
    els.total.textContent = String(a.totalMessages);
    els.answered.textContent = String(a.statusCounts.answered);
    els.declined.textContent = String(a.statusCounts.declined);
    els.errors.textContent = String(a.statusCounts.error);
  }

  function renderConfidenceDist(dist, total) {
    const denom = total || 1;
    els.confidenceDist.innerHTML = [
      kvRow('High', `${dist.high} (${Math.round((dist.high / denom) * 100)}%)`),
      kvRow('Medium', `${dist.medium} (${Math.round((dist.medium / denom) * 100)}%)`),
      kvRow('Low', `${dist.low} (${Math.round((dist.low / denom) * 100)}%)`),
      kvRow('Very low (declined)', `${dist.very_low} (${Math.round((dist.very_low / denom) * 100)}%)`),
    ].join('');
  }

  function renderFeedback(feedback) {
    if (feedback.total === 0) {
      els.feedback.innerHTML = kvRow('Feedback', 'No feedback submitted yet');
      return;
    }
    els.feedback.innerHTML = [
      kvRow('Helpful', `${feedback.helpful} (${Math.round((feedback.helpful / feedback.total) * 100)}%)`),
      kvRow('Not helpful', `${feedback.notHelpful} (${Math.round((feedback.notHelpful / feedback.total) * 100)}%)`),
    ].join('');
  }

  function renderLatency(latencyMs) {
    els.latencyRetrieval.textContent = latencyMs.avgRetrieval === null ? '—' : `${latencyMs.avgRetrieval}ms`;
    els.latencyLlm.textContent = latencyMs.avgLlm === null ? '—' : `${latencyMs.avgLlm}ms`;
    els.latencyTotal.textContent = latencyMs.avgTotal === null ? '—' : `${latencyMs.avgTotal}ms`;
    els.latencyP95.textContent = latencyMs.p95Total === null ? '—' : `${latencyMs.p95Total}ms`;
  }

  function renderRecent(messages) {
    els.recentBody.innerHTML = '';
    if (messages.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'text-small text-secondary';
      cell.textContent = 'No conversations logged yet.';
      row.appendChild(cell);
      els.recentBody.appendChild(row);
      return;
    }

    messages.forEach((m) => {
      const row = document.createElement('tr');

      const questionCell = document.createElement('td');
      questionCell.className = 'text-small';
      questionCell.textContent = m.questionText;

      const statusCell = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = `badge ${STATUS_BADGE[m.status] || 'badge--info'}`;
      statusBadge.textContent = labelize(m.status);
      statusCell.appendChild(statusBadge);

      const confidenceCell = document.createElement('td');
      const confidenceBadge = document.createElement('span');
      confidenceBadge.className = `badge ${CONFIDENCE_BADGE[m.confidenceTier] || 'badge--info'}`;
      confidenceBadge.textContent = labelize(m.confidenceTier);
      confidenceCell.appendChild(confidenceBadge);

      const latencyCell = document.createElement('td');
      latencyCell.textContent = `${m.totalLatencyMs}ms`;

      const feedbackCell = document.createElement('td');
      feedbackCell.textContent = m.feedback ? labelize(m.feedback) : '—';

      const whenCell = document.createElement('td');
      whenCell.textContent = formatDateTime(m.createdAt);

      row.append(questionCell, statusCell, confidenceCell, latencyCell, feedbackCell, whenCell);
      els.recentBody.appendChild(row);
    });
  }

  function kvRow(label, value) {
    return `<dt>${label}</dt><dd>${value}</dd>`;
  }

  function labelize(value) {
    return String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatDateTime(isoString) {
    const normalized = isoString.includes('T') ? isoString : isoString.replace(' ', 'T') + 'Z';
    return new Date(normalized).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

document.addEventListener('partials:loaded', initAdminCustomerAi);
