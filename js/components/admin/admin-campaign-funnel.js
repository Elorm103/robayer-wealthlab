/**
 * Robayer WealthLab — Campaign Performance (Admin Analytics Dashboard
 * v2, 2026-08-27; generalized from the Reliable Sales Funnel
 * Measurement pass's original single-campaign card). Drives the
 * [data-campaign-performance-root] container in
 * admin/analytics/index.html: one card per real (non-draft) email
 * campaign, each showing the full delivered→opens→clicks→visits→
 * views→checkout→coupon→purchase→download chain via GET
 * /api/admin/newsletter/campaigns (the list) and GET
 * /api/admin/analytics/campaigns/:id/funnel (per campaign) — both
 * pre-existing endpoints, reused as-is. See
 * services/admin/analyticsService.ts's getCampaignFunnel() for
 * exactly which stages are real vs. proxy vs. permanently
 * unmeasurable.
 *
 * "Campaign" here means an email send (newsletter_campaigns) — this
 * codebase has no Facebook/Meta Ads campaign entity or API
 * integration to report on individually (Meta Pixel/CAPI tracks
 * conversions, not ad-campaign performance), so Facebook/Instagram
 * traffic is deliberately NOT invented as a fake "campaign" here; its
 * real numbers already live in the Traffic Sources section instead
 * (admin-traffic.js's source breakdown table) — see this file's own
 * empty/no-campaigns copy, which says so explicitly rather than
 * silently omitting the channel.
 *
 * Not scoped to the page's date-range toolbar — a campaign's funnel is
 * a lifetime figure for that one send, not a range query.
 */

const CAMPAIGNS_LIST_API = '/api/admin/newsletter/campaigns';
const CAMPAIGN_FUNNEL_API = (id) => `/api/admin/analytics/campaigns/${id}/funnel`;
const REPORTABLE_STATUSES = new Set(['sending', 'sent', 'failed']);

function initAdminCampaignPerformance() {
  const root = document.querySelector('[data-campaign-performance-root]');
  if (!root || root.hasAttribute('data-bound')) return;
  root.setAttribute('data-bound', 'true');

  const els = {
    loadError: root.querySelector('[data-campaign-performance-load-error]'),
    empty: root.querySelector('[data-campaign-performance-empty]'),
    list: root.querySelector('[data-campaign-performance-list]'),
  };

  refresh();
  document.addEventListener('admin-analytics:refresh-requested', refresh);

  async function refresh() {
    if (els.loadError) els.loadError.hidden = true;
    try {
      const campaigns = await window.AdminAuth.adminFetch(CAMPAIGNS_LIST_API);
      const reportable = campaigns.filter((c) => REPORTABLE_STATUSES.has(c.status));

      if (reportable.length === 0) {
        if (els.empty) els.empty.hidden = false;
        if (els.list) els.list.hidden = true;
        return;
      }
      if (els.empty) els.empty.hidden = true;
      if (els.list) {
        els.list.hidden = false;
        els.list.innerHTML = '';
      }

      const funnels = await Promise.all(
        reportable.map((c) => window.AdminAuth.adminFetch(CAMPAIGN_FUNNEL_API(c.id)).catch(() => null))
      );
      funnels.forEach((funnel) => {
        if (funnel && els.list) els.list.appendChild(buildCampaignCard(funnel));
      });
    } catch (error) {
      if (els.loadError) {
        els.loadError.textContent = error.message || 'Could not load campaign performance.';
        els.loadError.hidden = false;
      }
    }
  }

  function buildCampaignCard(data) {
    const card = document.createElement('div');
    card.className = 'card campaign-performance-card mb-4';

    const heading = document.createElement('h3');
    heading.className = 'text-body mb-1';
    heading.textContent = data.subject;
    card.appendChild(heading);

    const tag = document.createElement('p');
    tag.className = 'text-secondary text-small mb-4';
    tag.textContent = data.utmCampaign
      ? `Email · Attribution tag: ${data.utmCampaign}`
      : 'Email · No attribution tag set on this campaign — landing-page-onward figures cannot be attributed to it.';
    card.appendChild(tag);

    const grid = document.createElement('div');
    grid.className = 'grid grid--3 mb-3';
    grid.append(
      stat('Recipients', String(data.recipients)),
      stat('Delivered', String(data.delivered)),
      stat('Bounced', String(data.bounced)),
      stageStat('Tracked opens', data.trackedOpens),
      stageStat('CTA clicks', data.ctaClicks),
      stat('Landing-page visits', formatStageValue(data.landingPageVisits)),
      stat('Book views', formatStageValue(data.productViews)),
      stat('Checkout starts', formatStageValue(data.checkoutStarts)),
      stat('Coupon applications', formatStageValue(data.couponApplications)),
      stat('Purchases', formatStageValue(data.purchases)),
      stat('Revenue', data.revenuePesewas === null ? 'Not available' : formatCurrency(data.revenuePesewas / 100)),
      stat('Downloads', formatStageValue(data.downloads))
    );
    card.appendChild(grid);
    return card;
  }

  function stat(label, value) {
    const wrap = document.createElement('div');
    wrap.className = 'stat-card';
    const p1 = document.createElement('p');
    p1.className = 'stat-card__label';
    p1.textContent = label;
    const p2 = document.createElement('p');
    p2.className = 'stat-card__value';
    p2.textContent = value;
    wrap.append(p1, p2);
    return wrap;
  }

  function stageStat(label, stage) {
    const wrap = stat(label, !stage || stage.value === null ? 'Not available' : String(stage.value));
    if (stage && stage.label) {
      const meta = document.createElement('p');
      meta.className = 'stat-card__meta text-secondary text-small';
      meta.textContent = stage.label;
      wrap.appendChild(meta);
    }
    return wrap;
  }

  function formatStageValue(value) {
    return value === null || value === undefined ? 'Not available' : String(value);
  }
}

/** Same GH₵ formatting convention as admin-products-funnel.js's own formatCurrency() — a small local copy per independent script, not a shared utility. */
function formatCurrency(amount) {
  if (!isFinite(amount)) return 'GH₵0.00';
  const rounded = Math.round(amount * 100) / 100;
  const parts = Math.abs(rounded).toFixed(2).split('.');
  const withSeparators = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + 'GH₵' + withSeparators + '.' + parts[1];
}

document.addEventListener('partials:loaded', initAdminCampaignPerformance);
