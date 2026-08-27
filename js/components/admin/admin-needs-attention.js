/**
 * Robayer WealthLab — Needs Attention (Admin Analytics Dashboard v2,
 * 2026-08-27). Drives the Needs Attention section on
 * admin/analytics/index.html: every alert here is derived from real
 * data already fetched by this page's other sections' own endpoints
 * (System Health, campaign performance, per-book funnel) — nothing is
 * a static/hardcoded warning, and nothing fires from a sample too
 * small to mean anything (see MIN_CHECKOUT_STARTS_FOR_ALERT below).
 *
 * Independent per-section script, matching this project's convention
 * — it re-fetches the same three (cheap, already-cached-where-KV-
 * backed) endpoints rather than reaching into the other section
 * scripts' internal state, so load order between scripts never
 * matters.
 */

const NEEDS_ATTENTION_HEALTH_API = '/api/admin/dashboard/health';
const NEEDS_ATTENTION_CAMPAIGNS_LIST_API = '/api/admin/newsletter/campaigns';
const NEEDS_ATTENTION_CAMPAIGN_FUNNEL_API = (id) => `/api/admin/analytics/campaigns/${id}/funnel`;
const PRODUCTS_FUNNEL_API = '/api/admin/analytics/products/funnel';
const NEEDS_ATTENTION_REPORTABLE_STATUSES = new Set(['sending', 'sent', 'failed']);

/** A book with only 1-2 checkout starts and zero purchases is not yet a meaningful signal — real launches routinely have a slow first sale. 3 is the smallest sample this dashboard is willing to call out by name. */
const MIN_CHECKOUT_STARTS_FOR_ALERT = 3;
/** A campaign that delivered to only a handful of people producing zero visits could just be small-sample noise; this needs a real send before "no visits" is worth flagging. */
const MIN_DELIVERED_FOR_ALERT = 10;

function initAdminNeedsAttention() {
  const root = document.querySelector('[data-needs-attention-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-needs-attention-load-error]'),
    empty: root.querySelector('[data-needs-attention-empty]'),
    list: root.querySelector('[data-needs-attention-list]'),
  };

  refresh();
  // Widened from 60s to 5 minutes (2026-08-27): this cycle alone fires
  // 3 admin-ops-read requests (health/campaigns/products-funnel, plus
  // one more per reportable campaign), and combined with System
  // Health's own 60s poll and the pre-existing Online Now 25s poll
  // (admin-live-activity.js), background polling from this page alone
  // was pushing real admin usage over the shared rate limit — see
  // routes/admin/analytics.ts's READ_RATE_LIMIT comment for the full
  // incident. Alerts here don't need sub-minute freshness the way
  // Online Now does; the top-bar health badge (60s) already surfaces
  // a RATE_LIMIT_KV-type issue faster if it matters.
  setInterval(refresh, 300_000);
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  async function refresh() {
    if (els.loadError) els.loadError.hidden = true;
    try {
      const alerts = await collectAlerts();
      render(alerts);
    } catch (error) {
      if (els.loadError) {
        els.loadError.textContent = error.message || 'Could not load Needs Attention.';
        els.loadError.hidden = false;
      }
    }
  }

  async function collectAlerts() {
    const alerts = [];

    const [health, campaigns, productsFunnel] = await Promise.all([
      window.AdminAuth.adminFetch(NEEDS_ATTENTION_HEALTH_API).catch(() => null),
      window.AdminAuth.adminFetch(NEEDS_ATTENTION_CAMPAIGNS_LIST_API).catch(() => []),
      window.AdminAuth.adminFetch(PRODUCTS_FUNNEL_API).catch(() => ({ items: [] })),
    ]);

    if (health) {
      health.checks
        .filter((c) => c.status !== 'healthy')
        .forEach((c) => {
          alerts.push({
            severity: c.status === 'error' ? 'error' : 'warning',
            title: `${c.label} is ${c.status === 'error' ? 'Down' : 'Degraded'}`,
            detail: c.detail,
          });
        });
    }

    const reportableCampaigns = campaigns.filter((c) => NEEDS_ATTENTION_REPORTABLE_STATUSES.has(c.status) && c.utmCampaign);
    const funnels = await Promise.all(
      reportableCampaigns.map((c) => window.AdminAuth.adminFetch(NEEDS_ATTENTION_CAMPAIGN_FUNNEL_API(c.id)).catch(() => null))
    );
    funnels.forEach((funnel) => {
      if (!funnel) return;
      if (funnel.delivered >= MIN_DELIVERED_FOR_ALERT && funnel.landingPageVisits === 0) {
        alerts.push({
          severity: 'warning',
          title: 'Email campaign has delivered but generated no tracked website visits',
          detail: `Campaign: ${funnel.utmCampaign} (${funnel.delivered} delivered)`,
        });
      }
    });

    (productsFunnel.items || []).forEach((item) => {
      if (item.checkoutStarts >= MIN_CHECKOUT_STARTS_FOR_ALERT && item.purchases === 0) {
        alerts.push({
          severity: 'warning',
          title: `${item.title} has checkout starts but no purchases`,
          detail: `${item.checkoutStarts} checkout starts, 0 purchases in the selected period.`,
        });
      }
    });

    return alerts;
  }

  function render(alerts) {
    const hasAlerts = alerts.length > 0;
    if (els.empty) els.empty.hidden = hasAlerts;
    if (els.list) {
      els.list.hidden = !hasAlerts;
      els.list.innerHTML = '';
      alerts.forEach((alert) => els.list.appendChild(buildAlertItem(alert)));
    }
  }

  /** Reuses the Executive Dashboard's own .alert-list/.alert-list__item--warning/--critical (css/admin.css) rather than inventing a parallel style — same visual language admins already know from admin/index.html. */
  function buildAlertItem(alert) {
    const li = document.createElement('li');
    li.className = 'alert-list__item alert-list__item--' + (alert.severity === 'error' ? 'critical' : 'warning');

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = alert.severity === 'error' ? '\u{1F534}' : '⚠️';

    const body = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'text-body';
    title.style.fontWeight = 'var(--weight-medium)';
    title.textContent = alert.title;
    const detail = document.createElement('p');
    detail.className = 'text-small';
    detail.textContent = alert.detail;
    body.append(title, detail);

    li.append(icon, body);
    return li;
  }
}

document.addEventListener('partials:loaded', initAdminNeedsAttention);
