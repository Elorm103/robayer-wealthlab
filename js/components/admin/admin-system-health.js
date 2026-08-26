/**
 * Robayer WealthLab — System Health (Admin Analytics Dashboard v2,
 * 2026-08-27). Drives both the top-bar overall-status badge and the
 * detailed System Health section on admin/analytics/index.html, from
 * the SAME GET /api/admin/dashboard/health endpoint the separate
 * Executive Dashboard (admin/index.html, admin-dashboard.js) already
 * uses — see services/admin/systemHealthService.ts's header comment
 * for the investigation that found System Health had simply never
 * been wired into this page (it isn't broken, it just never called
 * this endpoint), and for the new RATE_LIMIT_KV/Analytics/Online-Now/
 * derived-Checkout checks added there.
 *
 * The API still returns healthy/warning/error (unchanged, so the
 * Executive Dashboard's own consumption of this endpoint stays
 * untouched) — this script maps that to the HEALTHY/DEGRADED/DOWN
 * vocabulary this page's design calls for, plus an explicit UNKNOWN
 * for anything unrecognized or when the fetch itself fails. Status is
 * never conveyed by color alone: every check shows a visible status
 * word next to its dot, not just a colored dot.
 */

const HEALTH_API = '/api/admin/dashboard/health';
const HEALTH_POLL_INTERVAL_MS = 60_000;

const STATUS_META = {
  healthy: { word: 'Healthy', dotClass: 'healthy', badgeClass: 'badge--success', overallWord: 'Operational', emoji: '\u{1F7E2}' },
  warning: { word: 'Degraded', dotClass: 'warning', badgeClass: 'badge--warning', overallWord: 'Degraded', emoji: '\u{1F7E0}' },
  error: { word: 'Down', dotClass: 'error', badgeClass: 'badge--error', overallWord: 'Outage', emoji: '\u{1F534}' },
};
const UNKNOWN_META = { word: 'Unknown', dotClass: 'unknown', badgeClass: 'badge', overallWord: 'Unknown', emoji: '⚪' };

function statusMeta(status) {
  return STATUS_META[status] || UNKNOWN_META;
}

function initAdminSystemHealth() {
  const root = document.querySelector('[data-system-health-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const topBadge = document.querySelector('[data-overall-health-badge]');

  const els = {
    loadError: root.querySelector('[data-system-health-load-error]'),
    overallBadge: root.querySelector('[data-system-health-overall-badge]'),
    grid: root.querySelector('[data-system-health-grid]'),
    version: root.querySelector('[data-system-health-version]'),
    environment: root.querySelector('[data-system-health-environment]'),
    schema: root.querySelector('[data-system-health-schema]'),
    checkedAt: root.querySelector('[data-system-health-checked-at]'),
  };

  if (topBadge) {
    topBadge.addEventListener('click', (event) => {
      event.preventDefault();
      root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      root.setAttribute('tabindex', '-1');
      root.focus({ preventScroll: true });
    });
  }

  refresh();
  setInterval(refresh, HEALTH_POLL_INTERVAL_MS);
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  async function refresh() {
    if (els.loadError) els.loadError.hidden = true;
    try {
      const health = await window.AdminAuth.adminFetch(HEALTH_API);
      render(health);
    } catch (error) {
      if (els.loadError) {
        els.loadError.textContent = 'Could not load system health: ' + error.message;
        els.loadError.hidden = false;
      }
      if (topBadge) {
        topBadge.textContent = `${UNKNOWN_META.emoji} System Status Unknown`;
        topBadge.className = 'badge badge--overall-health';
      }
      // Keep the detailed section's own badge in sync with the top
      // bar rather than silently leaving it showing a now-stale
      // status from the last successful fetch.
      if (els.overallBadge) {
        els.overallBadge.textContent = `${UNKNOWN_META.emoji} Unknown`;
        els.overallBadge.className = 'badge';
      }
    }
  }

  function render(health) {
    const overall = statusMeta(health.overallStatus);

    if (topBadge) {
      topBadge.textContent = `${overall.emoji} System ${overall.overallWord}`;
      topBadge.className = 'badge badge--overall-health ' + overall.badgeClass;
    }
    if (els.overallBadge) {
      els.overallBadge.textContent = `${overall.emoji} ${overall.overallWord}`;
      els.overallBadge.className = 'badge ' + overall.badgeClass;
    }

    if (els.grid) {
      els.grid.innerHTML = '';
      health.checks.forEach((check) => {
        els.grid.appendChild(buildHealthItem(check));
      });
    }

    if (els.version) els.version.textContent = 'Version ' + health.appVersion;
    if (els.environment) els.environment.textContent = health.environment === 'production' ? 'Production' : 'Development';
    if (els.schema) els.schema.textContent = health.schemaVersion || 'Unknown';
    if (els.checkedAt) {
      const when = new Date(health.checkedAt);
      els.checkedAt.textContent = 'Last checked ' + when.toLocaleTimeString() + (health.cached ? ' (cached)' : '');
    }
  }

  function buildHealthItem(check) {
    const meta = statusMeta(check.status);
    const li = document.createElement('li');
    li.className = 'health-item';

    const dot = document.createElement('span');
    dot.className = 'health-item__dot health-item__dot--' + meta.dotClass;
    dot.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'health-item__body';

    const label = document.createElement('p');
    label.className = 'health-item__label';
    label.textContent = check.label;

    const status = document.createElement('p');
    status.className = 'health-item__status health-item__status--' + meta.dotClass;
    status.textContent = meta.word;

    const detail = document.createElement('p');
    detail.className = 'health-item__detail';
    detail.textContent = check.detail;

    body.append(label, status, detail);
    li.append(dot, body);
    return li;
  }
}

document.addEventListener('partials:loaded', initAdminSystemHealth);
